// Pure mapping from polytoken's DaemonEvent SSE stream to pilot's SessionDriverEvent
// stream. This is the testable heart of the polytoken driver — given a daemon event,
// an accumulator, and a little context, it returns zero or more pilot events to fold +
// broadcast, plus zero or more side-effect descriptors for the driver to execute.
//
// Mirrors the original pi driver's (deleted) event-map in discipline (pure, table-driven-tested), but
// polytoken's stream is LOWER LEVEL than the original driver's: it's Anthropic Messages-API-shaped
// (message_start → content_block_start → content_block_delta → content_block_stop →
// message_complete), so this mapper carries a small ACCUMULATOR that tracks the
// current block kind and accrues tool-use input. The original driver's stream was already semantic
// (text_delta, tool_execution_start, agent_end), so its mapper was near-stateless.
//
// Shapes grounded in docs/polytoken-spike.md (confirmed against a running daemon,
// polytoken 0.3.3) and the binary's own self-describing schemas (polytoken openapi /
// polytoken event-schema). The spike corrected several plan assumptions; those
// corrections are baked in here.

import type { components } from "./wire-types.js";
import type {
  ImageContent,
  SessionDriverEvent,
  SessionQueuedMessage,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
  SessionUsage,
  PermissionMonitorMode,
  WorkspaceRef,
} from "@pilot/protocol";
import { defaultModelRef } from "./models.js";
import type { PendingInterrogative, PendingInterrogativeType } from "./ui-bridge.js";
import {
  PERMISSION_APPROVAL_CHOICES,
  PERMISSION_APPROVAL_LABELS,
  type PendingQuestion,
  pruneApprovalOptions,
} from "./ui-bridge.js";

type DaemonEvent = components["schemas"]["DaemonEvent"];
type DaemonState = components["schemas"]["SessionStateSnapshot"];
type ProviderError = components["schemas"]["ProviderError"];

// ---------------------------------------------------------------------------
// Accumulator — the event-fold's working memory.
//
// polytoken streams content blocks incrementally: content_block_start sets the
// kind, content_block_delta(s) feed text or accrue tool-use input, content_block_stop
// closes the window. tool_call (authoritative, per spike §4) emits toolStarted.
// message_complete is the turn boundary (like the original driver's agent_end).
//
// The accumulator also tracks turn-level error state: model_error sets it,
// message_start (a retry/new message) clears it, message_complete consumes it to
// decide runFailed vs runCompleted. This mirrors the original driver's pattern of deferring the
// failure decision to the turn boundary (the original driver scans messages at agent_end for
// stopReason:"error"), rather than failing the run on every transient error that
// the daemon might retry past.
// ---------------------------------------------------------------------------

export type BlockKind =
  | "text"
  | "tool_use"
  | "thinking"
  | "redacted_thinking"
  | "open_ai_reasoning_opaque";

export interface FoldAccumulator {
  /** The current block's ContentBlockKind discriminator (from content_block_start).
   *  Null when no block is open. Routes deltas to the correct channel. */
  blockKind: BlockKind | null;
  /** Accumulated partial_json for an in-flight tool_use block (emitted on tool_call). */
  toolInputBuffer: string;
  /** The current tool_use block's metadata from content_block_start (id, name).
   *  Used as a fallback if the tool_call event omits them. */
  toolUseBlock: { id: string; name: string } | null;
  /** Set by model_error; consumed (and cleared) by message_complete. If set at
   *  turn end, the run fails instead of completing. Cleared by message_start
   *  (a retry starts a new message — the error was transient). */
  turnError: { message: string } | null;
}

export function createAccumulator(): FoldAccumulator {
  return {
    blockKind: null,
    toolInputBuffer: "",
    toolUseBlock: null,
    turnError: null,
  };
}

/** Reset an accumulator to its initial state. The driver MUST call this on SSE
 *  reconnect (a stream_discontinuity → reseed, or a fresh subscribe after a
 *  dropped connection): without it, a stale `turnError` from a turn that never
 *  reached message_complete (e.g. the daemon crashed mid-error-retry) would leave
 *  the session stuck "running" forever — the reseed refreshes the state snapshot
 *  to idle, but the accumulator's turnError would cause the NEXT message_complete
 *  to spuriously fail. Spike §6: SSE is push-only with no periodic heartbeats,
 *  so a reconnect is the only signal that stream state may have been lost. */
export function resetAccumulator(acc: FoldAccumulator): void {
  acc.blockKind = null;
  acc.toolInputBuffer = "";
  acc.toolUseBlock = null;
  acc.turnError = null;
}

// ---------------------------------------------------------------------------
// Context — provided by the driver, like the original driver's MapCtx.
// ---------------------------------------------------------------------------

export interface MapCtx {
  ref: SessionRef;
  workspace: WorkspaceRef;
  now(): string;
  /** Build a snapshot reflecting the current title/config/usage at a given status.
   *  Uses the driver's cached lastState (the mapper never does I/O). */
  snapshot(status: SessionStatus): SessionSnapshot;
  /** The session's live run status, for out-of-band events (a rename mid-turn) that
   *  must NOT report idle — that would close the streaming bubble + clear the
   *  running indicator. Derived from the cached state's turn_in_flight flag. */
  liveStatus(): SessionStatus;
}

// ---------------------------------------------------------------------------
// Effects — side-effect descriptors the mapper returns alongside events.
//
// The mapper is pure (no I/O). Some mappings need a state fetch (usage is on
// GET /state, not on the event — spike §4 correction) or a queue refresh. These
// are returned as effect descriptors; the driver executes them after emitting the
// pure events. For fetchState effects, the driver calls buildPostFetchEvent()
// (also pure, tested) to produce the follow-up event from the refreshed cache.
// ---------------------------------------------------------------------------

export type DaemonEffect =
  /** GET /state → refresh the cached state, then emit the named follow-up event
   *  via buildPostFetchEvent(). The mapper can't build these events itself because
   *  they need the FRESH state (usage, title, config) that only the fetch provides.
   *  `promptId` is the daemon's per-turn PromptId (carried by message_complete);
   *  buildPostFetchEvent threads it onto runCompleted as the branch-handle entryIds
   *  so the transcript's branch buttons work. Absent for sessionUpdated (no turn
   *  completed) and on the sessionUpdated fetchState from turn_cancelled. */
  | {
      type: "fetchState";
      emit: "runCompleted" | "sessionUpdated";
      promptId?: string;
    }
  /** GET /history + GET /state → full re-seed (spike §6: stream_discontinuity drops
   *  events; spike §7: session_rewound truncates history). Chunk 2 emits a
   *  sessionUpdated from the refreshed state; the full re-broadcast is Chunk 4. */
  | { type: "reseed" }
  /** GET /turn/input → queueUpdated with the refreshed queue. The queue events
   *  (queued/dequeued/discarded) don't carry the FULL queue, only one item +
   *  revision; pilot's queueUpdated REPLACES the full queue, so we must fetch. */
  | { type: "refetchQueue" }
  /** Update the cached permission-monitor mode (the permission_monitor_switch
   *  event carries the authoritative new mode; the cache must track it so
   *  subsequent ctx.snapshot() calls reflect it). Emitted alongside a
   *  sessionUpdated snapshot that carries the new mode directly (the snapshot is
   *  built from the event payload, not the still-stale cache). */
  | { type: "setMonitorMode"; mode: PermissionMonitorMode }
  /** Register a pending interrogative in the driver's pending map (so respondUi
   *  can build the reverse InterrogativeResponse from a later HostUiResponse) AND
   *  emit the matching pilot hostUiRequest card. The effect carries the
   *  PendingInterrogative metadata the reverse builder needs; the hostUiRequest
   *  event is in the returned `events` (emitted before effects, per the driver's
   *  emit-then-execute contract). */
  | { type: "registerInterrogative"; pending: PendingInterrogative };

export interface FoldResult {
  /** Pilot driver events to emit (broadcast to hub listeners). */
  events: SessionDriverEvent[];
  /** Side-effect requests for the driver to execute (HTTP calls) AFTER emitting. */
  effects: DaemonEffect[];
}

const EMPTY: FoldResult = { events: [], effects: [] };

function events(events: SessionDriverEvent[], effects: DaemonEffect[] = []): FoldResult {
  return { events, effects };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable message from a ProviderError (the model_error payload). */
function providerErrorMessage(error: ProviderError): string {
  switch (error.type) {
    case "rate_limited":
      return error.retry_after_seconds != null
        ? `Rate limited (retry in ${error.retry_after_seconds}s)`
        : "Rate limited";
    case "auth_failed":
      return "Authentication failed";
    case "login_required":
      return `Login required (${error.profile})`;
    case "model_not_found":
      return "Model not found";
    case "context_too_large":
      return "Context too large";
    case "transport":
      return `Transport error (${error.kind}): ${error.message}`;
    case "protocol_malformed":
      return `Protocol error: ${error.detail}`;
    case "canceled":
      return "Request canceled";
    case "other":
      return `${error.code}: ${error.message}`;
    default:
      return "Unknown provider error";
  }
}

/** Build a SessionSnapshot from a cached daemon state snapshot. Pure — used by the
 *  driver's ctx.snapshot() and by buildPostFetchEvent(). */
export function snapshotFromState(
  state: DaemonState | null,
  ref: SessionRef,
  workspace: WorkspaceRef,
  status: SessionStatus,
  now: string,
  monitorMode?: PermissionMonitorMode,
): SessionSnapshot {
  const title = state?.session_title ?? ref.sessionId;
  // active_model is stored as the FULL `provider/id` registry name
  // (e.g. "anthropic/claude-sonnet-4"). modelId stays the full registry name —
  // matching ModelOption.modelId from parseModels and the default markers via
  // defaultModelRef — so ModelPicker's store.models.find() resolves the friendly
  // label instead of falling back to the bare id. `provider` is the bare prefix
  // (group key), mirroring parseModels. If a model string ever lacks a slash (a
  // custom/local name), defaultModelRef degrades both to the whole string.
  const config = state?.active_model
    ? {
        ...defaultModelRef(state.active_model),
        thinkingLevel: state.active_reasoning_effort ?? undefined,
      }
    : undefined;
  return {
    ref,
    workspace,
    title,
    status,
    updatedAt: now,
    config,
    usage: usageFromState(state),
    facet: state?.active_facet ?? undefined,
    permissionMonitor: monitorMode,
    activePlan: state?.active_plan ?? undefined,
  };
}

/** Extract pilot's SessionUsage from a daemon state snapshot's context_usage. */
export function usageFromState(state: DaemonState | null): SessionUsage | undefined {
  const cu = state?.context_usage;
  if (!cu) return undefined;
  const percent =
    cu.limit_tokens > 0 ? Math.round((cu.used_tokens / cu.limit_tokens) * 100) : null;
  return { tokens: cu.used_tokens, contextWindow: cu.limit_tokens, percent };
}

/** Parse accumulated tool-use input. Falls back to raw string if not valid JSON. */
function parseToolInput(buffer: string): unknown {
  if (!buffer) return undefined;
  try {
    return JSON.parse(buffer);
  } catch {
    return buffer;
  }
}

/** Extract output text + lift image content from a polytoken tool_result event.
 *
 * `content` is the short-form truncated string; `content_full` carries the rich
 * display content (ToolLiveDisplayContent = ToolResultContent | {diff_preview}).
 * ToolResultContent has three variants: {text}, {blocks}, {image}. We lift the
 * image into the typed `images` field (like the original driver's splitToolResult) and extract text
 * for `output`.
 */
function extractToolResult(
  content: string | null | undefined,
  contentFull: unknown,
): { output: unknown; images?: readonly ImageContent[] } {
  if (contentFull && typeof contentFull === "object") {
    const cf = contentFull as Record<string, unknown>;
    // Image variant: {image: {data, media_type, text_fallback}}
    if (cf.image && typeof cf.image === "object") {
      const img = cf.image as { data?: string; media_type?: string; text_fallback?: string };
      if (typeof img.data === "string" && typeof img.media_type === "string") {
        return {
          output: content ?? img.text_fallback ?? "",
          images: [{ type: "image", data: img.data, mimeType: img.media_type }],
        };
      }
    }
    // Text variant: {text: string}
    if (typeof cf.text === "string") {
      return { output: content ?? cf.text };
    }
    // Blocks variant: {blocks: ContentBlock[]} — extract text blocks
    if (Array.isArray(cf.blocks)) {
      const text = cf.blocks
        .filter(
          (b) =>
            b && typeof b === "object" && (b as { type?: string }).type === "text",
        )
        .map((b) => (b as { text: string }).text)
        .join("");
      return { output: content ?? text };
    }
    // Diff preview variant: {diff_preview: {summary, ...}}
    if (cf.diff_preview && typeof cf.diff_preview === "object") {
      const dp = cf.diff_preview as { summary?: string };
      return { output: content ?? dp.summary ?? "" };
    }
  }
  return { output: content ?? undefined };
}

/** Build a stable SessionQueuedMessage from a pending_turn_input_drained event's
 *  content. The daemon doesn't distinguish steer from followUp (spike §3); pilot's
 *  mode is UX-only, so we default to "steer" (the mid-turn case). */
function drainedQueueMessage(
  text: string,
  itemId: string | undefined,
  ts: string,
): SessionQueuedMessage {
  return {
    id: itemId ?? `drain-${ts}`,
    mode: "steer",
    text,
    createdAt: ts,
    updatedAt: ts,
  };
}

// ---------------------------------------------------------------------------
// Forward interrogative mapping — DaemonEvent → pilot hostUiRequest card.
//
// Each builder returns (a) the pilot hostUiRequest event to emit AND (b) the
// PendingInterrogative metadata the reverse builder (ui-bridge.ts) needs to
// translate a later HostUiResponse back. The mapper bundles the metadata into
// a registerInterrogative effect; the driver stores it in its pending map.
//
// The index↔key/id mappings here are the SINGLE source of truth — ui-bridge.ts's
// reverse builders read them back by index, so the order here MUST match.
// ---------------------------------------------------------------------------

/** Build the pilot hostUiRequest + pending metadata for an `interrogative` event.
 *  One interrogative_type → one card kind. The card carries a stable requestId
 *  equal to the daemon's interrogative_id, so respondUi can look it up. For an
 *  unrecognized type (a runtime-only path — the `_exhaustive` guard catches
 *  codegen'd types), the default arm emits a blocking `confirm` dialog and
 *  registers the pending so the operator can dismiss it → {kind:"cancel"}. */
function buildInterrogativeMapping(
  ev: Extract<DaemonEvent, { type: "interrogative" }>,
  meta: { sessionRef: SessionRef; timestamp: string },
): { event: SessionDriverEvent; pending: PendingInterrogative | null } {
  const requestId = ev.interrogative_id;
  const pending: PendingInterrogative = {
    interrogativeId: ev.interrogative_id,
    interrogativeType: ev.interrogative_type,
  };
  switch (ev.interrogative_type) {
    case "confirmation": {
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: { kind: "confirm", requestId, title: "Confirm", message: ev.question },
      };
      return { event, pending };
    }
    case "clarification": {
      // Clarification options carry {key,label}. pilot's select renders labels;
      // the response carries the chosen LABEL, which the reverse builder maps
      // back to the daemon's key via the parallel labels/keys arrays.
      const options = ev.clarification_options ?? [];
      const labels = options.map((o) => o.label);
      const keys = options.map((o) => o.key);
      pending.clarificationLabels = labels;
      pending.clarificationOptionKeys = keys;
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: {
          kind: "select",
          requestId,
          title: ev.question,
          options: labels,
        },
      };
      return { event, pending };
    }
    case "capability": {
      // A capability grant is a yes/no — pilot's confirm card fits.
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: { kind: "confirm", requestId, title: "Grant capability?", message: ev.question },
      };
      return { event, pending };
    }
    case "plan_handoff": {
      // Plan handoff: 3 choices. The action_labels (from PlanHandoffContext) give
      // the button text; the index order matches ui-bridge's PLAN_HANDOFF_DECISIONS.
      // Capture the rendered labels so the reverse builder can map the chosen
      // label → index → decision (the client sends the label, not an index).
      // Unlike `select`, the `plan` kind carries the plan markdown so ApprovalLayer
      // renders it instead of a blind generic dropdown.
      const ph = ev.plan_handoff;
      const labels = ph
        ? [
            ph.action_labels.implement_new_context,
            ph.action_labels.implement_current_context,
            ph.action_labels.cancel,
          ]
        : ["Implement (new context)", "Implement (current context)", "Cancel"];
      pending.planHandoffLabels = labels;
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: {
          kind: "plan",
          requestId,
          title: ph?.title ?? "Plan handoff",
          planText: ph?.plan_text ?? "",
          displayPath: ph?.display_path ?? undefined,
          targetFacet: ph?.target_facet ?? undefined,
          actionLabels: labels as [string, string, string],
        },
      };
      return { event, pending };
    }
    case "permission": {
      // Permission approval: surfaces the tool name + input preview + pruned
      // options (only grants whose persistence target the daemon allows). The
      // buildPermissionRequest helper captures the pruned choices in pending so
      // the reverse builder maps the chosen label → the right grant/target pair.
      return buildPermissionRequest(ev, meta, pending);
    }
    case "goal_proposal": {
      // Goal proposal: the daemon proposes a goal and asks accept/reject. The
      // GoalProposalContext carries title + proposed_summary + optional file
      // path + action_labels (accept/reject button text). We render a confirm
      // card (Accept/Reject = confirmed true/false). The response maps to
      // goal_proposal_answer{accepted: boolean}.
      const gp = ev.goal_proposal;
      const title = gp?.title ?? "Goal proposal";
      const summary = gp?.proposed_summary ?? "";
      const message = summary || title;
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: { kind: "confirm", requestId, title, message },
      };
      return { event, pending };
    }
    default: {
      // Runtime safety: a compile-time exhaustiveness guard can't catch an
      // out-of-enum `interrogative_type` from a newer daemon (the wire is
      // JSON.parse'd). Instead of a fire-and-forget notify (which left the
      // daemon's turn permanently blocked), emit a BLOCKING confirm dialog
      // with requestId == interrogative_id so respondUi can match it and
      // POST {kind:"cancel"} when the operator dismisses it. This prevents
      // any future unknown interrogative type from wedging the session.
      const _exhaustive: never = ev.interrogative_type;
      void _exhaustive;
      const unknownType = (ev as { interrogative_type?: string }).interrogative_type ?? "unknown";
      pending.interrogativeType = "unknown" as PendingInterrogativeType;
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: {
          kind: "confirm",
          requestId,
          title: `⚠ Unknown request type: ${unknownType}`,
          message:
            "The agent sent a request type this version of pilot doesn't recognize. Dismiss to cancel it and unblock the session.",
        },
      };
      return { event, pending };
    }
  }
}

/** Build the pilot `permission` hostUiRequest + pending metadata for a
 *  permission interrogative. Surfaces the tool name + a JSON preview of the
 *  tool's input (from the daemon's permission_tool_call), and prunes the 7
 *  approval choices down to those whose persistence target the daemon's
 *  keep_targets rule allows.
 *
 *  The pruned choices are captured in `pending.permissionChoices` so the
 *  reverse builder (ui-bridge.ts) can map the chosen label → its grant/target
 *  pair. Pruning uses the shared `pruneApprovalOptions` helper — the single
 *  source of truth, also used by the mock fixture. */
function buildPermissionRequest(
  ev: Extract<DaemonEvent, { type: "interrogative" }>,
  meta: { sessionRef: SessionRef; timestamp: string },
  pending: PendingInterrogative,
): { event: SessionDriverEvent; pending: PendingInterrogative } {
  const tc = ev.permission_tool_call;
  const toolName = tc?.tool_name ?? null;
  // JSON-stringify the tool input for display, truncating to bound the card.
  // A null tool_call → null input (degraded but not silent).
  let toolInput: string | null = null;
  if (tc) {
    const json = safeStringify(tc.input);
    toolInput = json.length > 500 ? `${json.slice(0, 499)}…` : json;
  }

  const keepTargets = ev.permission_candidate_rule?.keep_targets ?? null;
  const choices = pruneApprovalOptions(keepTargets);
  pending.permissionChoices = choices;
  // Map each pruned choice to its label via the ORIGINAL index in the full
  // choices array (a choice's label is at the same index in
  // PERMISSION_APPROVAL_LABELS). Using the pruned array's index would misalign
  // labels after the first pruned entry.
  const options = choices
    .map((choice) => PERMISSION_APPROVAL_CHOICES.indexOf(choice))
    .map((i) => PERMISSION_APPROVAL_LABELS[i])
    .filter((l): l is string => !!l);

  const event: SessionDriverEvent = {
    ...meta,
    type: "hostUiRequest",
    request: {
      kind: "permission",
      requestId: ev.interrogative_id,
      title: ev.question || "Approve?",
      toolName,
      toolInput,
      options,
    },
  };
  return { event, pending };
}

/** JSON.stringify with a fallback for non-serializable values (BigInt, cycles).
 *  The tool input is `unknown` from the wire; a failed stringify shouldn't crash
 *  the fold — fall back to String() so SOMETHING shows. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Build the pilot hostUiRequest (qna) + pending metadata for an
 *  ask_user_question event. Each question maps to a QnaQuestion; the option ids
 *  are captured so the reverse builder can map selected indices → ids. */
function buildAskUserQuestionMapping(
  ev: Extract<DaemonEvent, { type: "ask_user_question" }>,
  meta: { sessionRef: SessionRef; timestamp: string },
): { event: SessionDriverEvent; pending: PendingInterrogative } {
  const requestId = ev.interrogative_id;
  const questions = ev.payload.questions;
  const pendingQuestions: PendingQuestion[] = questions.map((q) => ({
    questionId: q.id,
    optionIds: (q.options ?? []).map((o) => o.id),
    optionLabels: (q.options ?? []).map((o) => o.label),
  }));
  const pending: PendingInterrogative = {
    interrogativeId: ev.interrogative_id,
    interrogativeType: "ask_user_question",
    questions: pendingQuestions,
  };
  // Map the daemon's AskUserQuestion to pilot's QnaQuestion. single_select /
  // multi_select → a choice card (options present); text → free-text.
  const pilotQuestions = questions.map((q) => ({
    question: q.question,
    context: q.context ?? undefined,
    options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? undefined })),
    multiSelect: q.mode === "multi_select",
  }));
  const event: SessionDriverEvent = {
    ...meta,
    type: "hostUiRequest",
    request: {
      kind: "qna",
      requestId,
      questions: pilotQuestions,
    },
  };
  return { event, pending };
}

// ---------------------------------------------------------------------------
// Post-fetch event builder — pure, tested separately.
//
// After the driver executes a fetchState effect (GET /state → update cache), it
// calls this to build the follow-up event from the refreshed ctx (which reads the
// now-updated cache). This keeps ALL event-construction logic in pure, testable
// functions — the driver is just the I/O glue.
// ---------------------------------------------------------------------------

export function buildPostFetchEvent(
  emit: "runCompleted" | "sessionUpdated",
  ctx: MapCtx,
  /** The daemon's per-turn PromptId (from message_complete, threaded through the
   *  fetchState effect). On runCompleted, becomes both userEntryId and
   *  assistantEntryId — the branch handles the reducer stamps onto the turn's
   *  last user + assistant items so the transcript's branch buttons resolve.
   *  Absent on sessionUpdated (no turn completed). */
  promptId?: string,
): SessionDriverEvent {
  const meta = { sessionRef: ctx.ref, timestamp: ctx.now() };
  if (emit === "runCompleted") {
    return {
      ...meta,
      type: "runCompleted",
      snapshot: ctx.snapshot("idle"),
      // The daemon assigns one PromptId per user turn; the user message and the
      // assistant reply share it. Both branch buttons ("branch from this prompt"
      // on the user item, "branch from here" on the assistant item) call
      // branchFrom with this id → POST /rewind { to_prompt_id }. Absent
      // (undefined) when the daemon omitted prompt_id — the buttons stay hidden,
      // matching the pre-fix state, rather than sending a bad rewind target.
      ...(promptId
        ? { userEntryId: promptId, assistantEntryId: promptId }
        : {}),
    };
  }
  return {
    ...meta,
    type: "sessionUpdated",
    snapshot: ctx.snapshot(ctx.liveStatus()),
  };
}

// ---------------------------------------------------------------------------
// The mapper — map one DaemonEvent to zero or more pilot events + effects.
//
// Subagent routing: every event variant (except subsession_*, mcp_server_*,
// subagent_*, notification_autodrain_switch) carries an optional subagent_handle.
// When non-null, the frame belongs to a NESTED subagent turn (spike §4) — not the
// top-level transcript. Chunk 2 routes these to empty (the subagent view is later);
// they must NOT pollute the top-level transcript.
// ---------------------------------------------------------------------------

export function mapDaemonEvent(
  ev: DaemonEvent,
  acc: FoldAccumulator,
  ctx: MapCtx,
): FoldResult {
  // Subagent routing: skip frames from nested subagent turns.
  const subHandle = (ev as { subagent_handle?: string | null }).subagent_handle;
  if (subHandle != null) return EMPTY;

  const meta = { sessionRef: ctx.ref, timestamp: ctx.now() };

  switch (ev.type) {
    // ===== Turn boundaries =====

    case "message_start": {
      // A turn began — the turn-start signal (like the original driver's agent_start). Also clears
      // any transient error state: if the daemon retries after a model_error, this
      // new message_start means the retry is underway.
      acc.turnError = null;
      return events([
        { ...meta, type: "sessionUpdated", snapshot: ctx.snapshot("running") },
      ]);
    }

    case "message_complete": {
      // The turn ended — the boundary choke point (like the original driver's agent_end). If a
      // model_error occurred during the turn (and wasn't cleared by a retry's
      // message_start), fail the run; otherwise fetch fresh state for usage +
      // emit runCompleted.
      if (acc.turnError) {
        const errMsg = acc.turnError.message;
        acc.turnError = null;
        return events([
          {
            ...meta,
            type: "runFailed",
            error: { message: errMsg },
          },
        ]);
      }
      // Usage is on GET /state, not on the event (spike §4 correction). Defer to
      // the driver's fetchState effect, which refreshes the cache and then calls
      // buildPostFetchEvent("runCompleted", ctx, promptId) to produce the
      // runCompleted event. The prompt_id is the daemon's per-turn id — the same
      // one the user message and assistant reply share — and becomes the branch
      // handle (entryId) that the transcript's "branch from here" buttons name.
      return events([], [
        { type: "fetchState", emit: "runCompleted", promptId: ev.prompt_id },
      ]);
    }

    case "turn_cancelled": {
      // Abort ack — the turn was cancelled. Re-read state for the authoritative
      // status (the daemon may have already settled to idle).
      return events([], [{ type: "fetchState", emit: "sessionUpdated" }]);
    }

    // ===== Content block streaming (the accumulator) =====

    case "content_block_start": {
      // Set the current block kind so deltas know which channel to route to.
      acc.blockKind = ev.block_type.type;
      acc.toolInputBuffer = "";
      if (ev.block_type.type === "tool_use") {
        acc.toolUseBlock = { id: ev.block_type.id, name: ev.block_type.name };
      } else {
        acc.toolUseBlock = null;
      }
      return EMPTY;
    }

    case "content_block_delta": {
      const delta = ev.delta;
      // text → assistantDelta (main channel)
      if (delta.type === "text" && acc.blockKind === "text") {
        return events([
          { ...meta, type: "assistantDelta", text: delta.text, channel: "text" },
        ]);
      }
      // thinking → assistantDelta (thinking channel)
      if (delta.type === "thinking" && acc.blockKind === "thinking") {
        return events([
          { ...meta, type: "assistantDelta", text: delta.text, channel: "thinking" },
        ]);
      }
      // redacted_thinking → assistantDelta (thinking channel, redacted content)
      if (
        delta.type === "redacted_thinking" &&
        acc.blockKind === "redacted_thinking"
      ) {
        return events([
          { ...meta, type: "assistantDelta", text: delta.data, channel: "thinking" },
        ]);
      }
      // open_ai_reasoning_opaque → assistantDelta (thinking channel, opaque reasoning)
      if (
        delta.type === "open_ai_reasoning_opaque" &&
        acc.blockKind === "open_ai_reasoning_opaque"
      ) {
        return events([
          { ...meta, type: "assistantDelta", text: delta.data, channel: "thinking" },
        ]);
      }
      // tool_use_input → accumulate partial JSON (emit on tool_call)
      if (delta.type === "tool_use_input" && acc.blockKind === "tool_use") {
        acc.toolInputBuffer += delta.partial_json;
      }
      // signature_delta: Anthropic thinking-block signature — pass through (no
      // pilot event; preserved for turn-2 replay by the daemon).
      return EMPTY;
    }

    case "content_block_stop": {
      // Block complete. The tool_use accumulator emits on tool_call, not here.
      acc.blockKind = null;
      return EMPTY;
    }

    // ===== Tool plumbing =====

    case "tool_call": {
      // tool_call is authoritative (spike §4): input is the complete parsed input.
      // Prefer the event's input; fall back to the accumulated buffer.
      const input =
        ev.input !== undefined ? ev.input : parseToolInput(acc.toolInputBuffer);
      const name = ev.name ?? acc.toolUseBlock?.name ?? "unknown";
      const callId = ev.call_id ?? acc.toolUseBlock?.id ?? "";
      return events([
        { ...meta, type: "toolStarted", toolName: name, callId, input },
      ]);
    }

    case "tool_result": {
      const { output, images } = extractToolResult(ev.content, ev.content_full);
      return events([
        {
          ...meta,
          type: "toolFinished",
          callId: ev.call_id,
          success: ev.is_error !== true,
          output,
          ...(images ? { images } : {}),
        },
      ]);
    }

    // ===== Queue (steering / follow-up) =====

    case "pending_turn_input_queued":
    case "pending_turn_input_dequeued":
    case "pending_turn_input_discarded": {
      // These events carry one item + revision, NOT the full queue. pilot's
      // queueUpdated REPLACES the full queue, so we must fetch GET /turn/input.
      return events([], [{ type: "refetchQueue" }]);
    }

    case "pending_turn_input_drained": {
      // A queued message is being delivered (admitted into the active turn).
      // Emit queuedMessageStarted (with the content). The spike (§3) only observed
      // single-item drains (item_ids.length === 1), so we declare the queue empty
      // in that case. If the daemon ever batches multiple drains in one event,
      // we can't know from item_ids[0] alone whether the queue is now empty — so
      // conservatively emit a refetchQueue effect to get the authoritative queue
      // state when more than one item was drained.
      const msg = drainedQueueMessage(
        ev.content,
        ev.item_ids[0],
        ctx.now(),
      );
      const singleItem = ev.item_ids.length <= 1;
      const evs: SessionDriverEvent[] = [
        { ...meta, type: "queuedMessageStarted", message: msg },
      ];
      if (singleItem) {
        evs.push({ ...meta, type: "queueUpdated", messages: [] });
        return events(evs);
      }
      // Multi-item drain: emit the started message, then fetch the real queue.
      return events(evs, [{ type: "refetchQueue" }]);
    }

    // ===== Errors + retries =====

    case "model_error": {
      // A provider error occurred. Don't fail the run yet — the daemon may retry
      // (retry_wait → message_start clears the error). Defer the failure decision
      // to message_complete, like the original driver defers to agent_end. Surface a warning notify.
      const message = providerErrorMessage(ev.error);
      acc.turnError = { message };
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `model-error-${meta.timestamp}`,
            message,
            level: "warning",
          },
        },
      ]);
    }

    case "retry_wait": {
      // The daemon is waiting before retrying (like the original driver's auto_retry_start).
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `retry-${meta.timestamp}`,
            message: `Retrying (attempt ${ev.attempt}/${ev.max_retries}): ${ev.error_summary}`,
            level: "warning",
          },
        },
      ]);
    }

    case "stream_discontinuity": {
      // Events were dropped (spike §6) — re-seed from GET /history + GET /state.
      return events([], [{ type: "reseed" }]);
    }

    // ===== Session metadata =====

    case "session_title_changed": {
      // The event carries the title + source (operator|inferred). Build a snapshot
      // at the live status (a rename can land mid-turn; don't force idle).
      return events([
        {
          ...meta,
          type: "sessionUpdated",
          snapshot: { ...ctx.snapshot(ctx.liveStatus()), title: ev.title },
        },
      ]);
    }

    case "session_state_changed": {
      // The daemon's state changed (carries invalidation domains, not values).
      // Re-read GET /state for the authoritative snapshot.
      return events([], [{ type: "fetchState", emit: "sessionUpdated" }]);
    }

    case "model_switch": {
      // The model/reasoning changed. The event carries from/to — build a snapshot
      // with the NEW config directly (no state fetch needed).
      // Same full-registry-name modelId as snapshotFromState — to_model is the
      // FULL `provider/id`, so defaultModelRef gives the bare provider prefix +
      // the full modelId (matching ModelOption.modelId) so the picker's find()
      // resolves the friendly label. Degrades both to the whole string if a model
      // string ever lacks a slash (config is display-only).
      const config = {
        ...defaultModelRef(ev.to_model),
        thinkingLevel: ev.to_reasoning_effort ?? undefined,
      };
      return events([
        {
          ...meta,
          type: "sessionUpdated",
          snapshot: {
            ...ctx.snapshot(ctx.liveStatus()),
            config,
          },
        },
      ]);
    }

    case "session_rewound": {
      // History was truncated (spike §7: destructive rewind). Re-seed.
      return events([], [{ type: "reseed" }]);
    }

    case "context_cleared": {
      // /clear was called (resets context + shell env). Re-seed.
      return events([], [{ type: "reseed" }]);
    }

    case "facet_switch": {
      // Facet changed (mid-conversation persona switch). Chunk 5 surfaces the facet
      // indicator (name + accent color); for now, re-read state for the snapshot.
      return events([], [{ type: "fetchState", emit: "sessionUpdated" }]);
    }

    // ===== Compaction =====

    case "compaction_started": {
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `compact-${meta.timestamp}`,
            message: "Compacting context…",
            level: "info",
          },
        },
      ]);
    }

    case "compaction_complete": {
      // Usage changed after compaction — re-read state for the context meter.
      return events(
        [
          {
            ...meta,
            type: "hostUiRequest",
            request: {
              kind: "notify",
              requestId: `compact-done-${meta.timestamp}`,
              message: "Context compacted",
              level: "info",
            },
          },
        ],
        [{ type: "fetchState", emit: "sessionUpdated" }],
      );
    }

    case "compaction_cancelled": {
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `compact-cancelled-${meta.timestamp}`,
            message: "Compaction cancelled",
            level: "warning",
          },
        },
      ]);
    }

    case "compaction_failed": {
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `compact-failed-${meta.timestamp}`,
            message: "Compaction failed",
            level: "error",
          },
        },
      ]);
    }

    case "subagent_compaction_notice": {
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `subagent-compact-${meta.timestamp}`,
            message: ev.summary,
            level: "info",
          },
        },
      ]);
    }

    // ===== Notifications =====

    case "notification_queued": {
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `notif-${ev.notification.id}`,
            message: ev.notification.summary,
            level: "info",
          },
        },
      ]);
    }

    // ===== System reminders =====

    case "system_reminder": {
      // A system-injected reminder — like the original driver's role:"custom" message with
      // display:false: it splits the turn (a robustness net) without rendering
      // user-facing content. Chunk 5 may surface some reminders visibly.
      return events([
        {
          ...meta,
          type: "customMessage",
          id: `reminder-${ev.slug}-${meta.timestamp}`,
          customType: ev.slug,
          text: ev.body,
          display: false,
        },
      ]);
    }

    // ===== Host UI + permissions (Chunk 3) =====
    //
    // interrogative / ask_user_question / permission_monitor_switch are the
    // daemon's host-UI surface. The first two emit a pilot hostUiRequest card
    // (the turn is paused until the operator answers) and a registerInterrogative
    // effect so the driver can build the reverse response. The third is an
    // ambient mode-change notify (the mode SWITCHER itself is a Chunk 5 concern;
    // the approval CARDS surface via interrogative{type:"permission"}).

    case "interrogative": {
      // The 6 interrogative_types each map to a pilot card kind. The card's
      // requestId == the daemon's interrogative_id, so respondUi can look up the
      // pending metadata to build the InterrogativeResponse. An unrecognized type
      // (runtime-only) renders a blocking confirm dialog + non-null pending so
      // the operator can dismiss it → {kind:"cancel"}.
      const { event, pending } = buildInterrogativeMapping(ev, meta);
      return pending
        ? events([event], [{ type: "registerInterrogative", pending }])
        : events([event]);
    }

    case "ask_user_question": {
      // A separate DaemonEvent (not an interrogative_type), but responds via the
      // same /interrogative/{id}/respond endpoint with kind:"ask_user_question_answers".
      // Maps to pilot's qna card (purpose-built multi-question form).
      const { event, pending } = buildAskUserQuestionMapping(ev, meta);
      return events([event], [{ type: "registerInterrogative", pending }]);
    }

    case "permission_monitor_switch": {
      // The permission MODE changed (standard/bypass/autonomous) — daemon-side
      // (e.g. an autonomous classifier took over approvals) or echoing a
      // user-initiated POST /permission-monitor. Update the cached mode + emit a
      // sessionUpdated snapshot carrying the new mode so the composer-toolbar
      // badge reflects it. (Replaces the old notify toast — the persistent badge
      // is strictly better than a transient toast; the switcher UI has landed.)
      const toMode = ev.to_monitor.type;
      return events(
        [
          {
            ...meta,
            type: "sessionUpdated",
            snapshot: { ...ctx.snapshot(ctx.liveStatus()), permissionMonitor: toMode },
          },
        ],
        [{ type: "setMonitorMode", mode: toMode }],
      );
    }

    // ===== v1-ignored variants (return empty — the stream stays live) =====
    //
    // These are ambient metadata, new concepts not yet surfaced, or Chunk 3/5
    // concerns. Each is tested to assert it returns empty (the table-driven test
    // matrix writes itself from the 57-variant enumeration).

    case "heartbeat":
    case "notification_autodrain_switch":
    case "notifications_drained":
    case "hook_fired":
    case "context_loaded":
    case "tool_reveal":
    case "tool_exposure_changed":
    case "classifier_decision":
    case "extension_registered":
    case "subagent_started":
    case "subagent_completed":
    case "subsession_created":
    case "subsession_stopped":
    case "subsession_terminated":
    case "subsession_interrogative":
    case "subsession_message":
    case "mcp_server_connected":
    case "mcp_server_disconnected":
    case "mcp_server_reconnecting":
    case "mcp_server_disabled":
    case "image_reference_resolved":
    case "job_promoted":
    case "job_completed":
    case "job_expiring":
    case "job_cancelled":
    case "job_updated":
    case "goal_driver_update":
    case "agent_block_violation":
    case "usage_throttle":
      return EMPTY;

    default: {
      // Compile-time exhaustiveness check: if a new DaemonEvent variant is added
      // to the generated schema and this switch isn't updated, `_exhaustive: never`
      // fails to compile (a TypeScript error). That catches KNOWN variants added
      // via a codegen regen.
      //
      // BUT: at runtime, the SSE stream is JSON.parse'd wire data — a genuinely
      // unknown `type` string (e.g. a new variant from a newer daemon the codegen
      // hasn't caught yet) falls through here. The `never` check can't catch that.
      // So we ALSO emit a one-shot warn at runtime so the unknown variant is
      // OBSERVABLE (the plan's loud-failure principle: don't silently swallow a
      // new variant — the UI would just stop reflecting it). A console.warn (not a
      // crash) keeps the stream live during a live turn.
      const _exhaustive: never = ev;
      void _exhaustive;
      const unknownType = (ev as { type?: string }).type ?? "unknown";
      console.warn(`[polytoken] unhandled DaemonEvent type: ${unknownType}`);
      return EMPTY;
    }
  }
}
