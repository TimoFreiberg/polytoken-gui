// Pure mapping from polytoken's DaemonEvent SSE stream to pilot's SessionDriverEvent
// stream. This is the testable heart of the polytoken driver — given a daemon event,
// an accumulator, and a little context, it returns zero or more pilot events to fold +
// broadcast, plus zero or more side-effect descriptors for the driver to execute.
//
// Mirrors server/src/pi/event-map.ts in discipline (pure, table-driven-tested), but
// polytoken's stream is LOWER LEVEL than pi's: it's Anthropic Messages-API-shaped
// (message_start → content_block_start → content_block_delta → content_block_stop →
// message_complete), so this mapper carries a small ACCUMULATOR that tracks the
// current block kind and accrues tool-use input. pi's stream was already semantic
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
  WorkspaceRef,
} from "@pilot/protocol";
import type { PendingInterrogative } from "./ui-bridge.js";
import {
  PERMISSION_APPROVAL_LABELS,
  type PendingQuestion,
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
// message_complete is the turn boundary (like pi's agent_end).
//
// The accumulator also tracks turn-level error state: model_error sets it,
// message_start (a retry/new message) clears it, message_complete consumes it to
// decide runFailed vs runCompleted. This mirrors pi's pattern of deferring the
// failure decision to the turn boundary (pi scans messages at agent_end for
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
// Context — provided by the driver, like pi's MapCtx.
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
   *  they need the FRESH state (usage, title, config) that only the fetch provides. */
  | { type: "fetchState"; emit: "runCompleted" | "sessionUpdated" }
  /** GET /history + GET /state → full re-seed (spike §6: stream_discontinuity drops
   *  events; spike §7: session_rewound truncates history). Chunk 2 emits a
   *  sessionUpdated from the refreshed state; the full re-broadcast is Chunk 4. */
  | { type: "reseed" }
  /** GET /turn/input → queueUpdated with the refreshed queue. The queue events
   *  (queued/dequeued/discarded) don't carry the FULL queue, only one item +
   *  revision; pilot's queueUpdated REPLACES the full queue, so we must fetch. */
  | { type: "refetchQueue" }
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
): SessionSnapshot {
  const title = state?.session_title ?? ref.sessionId;
  // active_model is stored as "provider/modelId" (e.g. "anthropic/claude-sonnet-4").
  // If a model string ever lacks a slash (a custom/local name), provider gets the
  // whole string and modelId is undefined — config is display-only and degrades.
  // NOTE: modelId here is the BARE id (split on `/`), while ModelOption.modelId
  // (from parseModels) is the FULL `provider/id` registry name. So after a model
  // switch, the active-session badge shows the bare id instead of the friendly
  // label (ModelPicker's store.models.find() matches the full form and misses).
  // Display-only — switching itself works (the client POSTs the full ModelOption
  // modelId, never this bare config one). To be unified in a follow-up.
  const config = state?.active_model
    ? {
        provider: state.active_model.split("/")[0],
        modelId: state.active_model.split("/")[1],
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
 * image into the typed `images` field (like pi's splitToolResult) and extract text
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
 *  equal to the daemon's interrogative_id, so respondUi can look it up. Returns
 *  `pending: null` for an unrecognized type (a runtime-only path — the
 *  `_exhaustive` guard catches codegen'd types): the caller emits the notify
 *  but registers no pending, since no answerable card was rendered. */
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
          kind: "select",
          requestId,
          title: ph?.title ?? "Plan handoff",
          options: labels,
        },
      };
      return { event, pending };
    }
    case "permission": {
      // Permission approval: 7 choices (deny + 6 grants). The index↔target
      // mapping lives in ui-bridge.ts's PERMISSION_APPROVAL_CHOICES — this just
      // renders the labels in that exact order.
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: {
          kind: "select",
          requestId,
          title: "Approve?",
          options: [...PERMISSION_APPROVAL_LABELS],
        },
      };
      return { event, pending };
    }
    default: {
      // Runtime safety: a compile-time exhaustiveness guard can't catch an
      // out-of-enum `interrogative_type` from a newer daemon (the wire is
      // JSON.parse'd). Surface it as a notify (loud-failure principle) so the
      // fold stays live — the operator sees an unknown interrogative was
      // dropped rather than a silent stall. No pending is registered: the notify
      // card is fire-and-forget (no requestId == interrogative_id), so there's
      // nothing for respondUi to match. The daemon's turn is stuck waiting (the
      // operator can cancel/abort), but that's strictly better than crashing
      // the whole SSE fold.
      const _exhaustive: never = ev.interrogative_type;
      void _exhaustive;
      const unknownType = (ev as { interrogative_type?: string }).interrogative_type ?? "unknown";
      const event: SessionDriverEvent = {
        ...meta,
        type: "hostUiRequest",
        request: {
          kind: "notify",
          requestId: `unknown-interrogative-${meta.timestamp}`,
          message: `Unrecognized interrogative type: ${unknownType}`,
          level: "warning",
        },
      };
      return { event, pending: null };
    }
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
): SessionDriverEvent {
  const meta = { sessionRef: ctx.ref, timestamp: ctx.now() };
  if (emit === "runCompleted") {
    return { ...meta, type: "runCompleted", snapshot: ctx.snapshot("idle") };
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
      // A turn began — the turn-start signal (like pi's agent_start). Also clears
      // any transient error state: if the daemon retries after a model_error, this
      // new message_start means the retry is underway.
      acc.turnError = null;
      return events([
        { ...meta, type: "sessionUpdated", snapshot: ctx.snapshot("running") },
      ]);
    }

    case "message_complete": {
      // The turn ended — the boundary choke point (like pi's agent_end). If a
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
      // buildPostFetchEvent("runCompleted", ctx) to produce the runCompleted event.
      return events([], [{ type: "fetchState", emit: "runCompleted" }]);
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
      // to message_complete, like pi defers to agent_end. Surface a warning notify.
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
      // The daemon is waiting before retrying (like pi's auto_retry_start).
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
      // Same provider/modelId split as snapshotFromState — degrades gracefully if
      // the model string lacks a slash (config is display-only).
      // NOTE: modelId here is the BARE id (split on `/`), while ModelOption.modelId
      // is the FULL `provider/id`. So the active-session badge shows the bare id
      // instead of the friendly label (ModelPicker's store.models.find() matches
      // the full form and misses). Display-only — switching itself works (the
      // client POSTs the full ModelOption modelId, never this bare config one).
      // To be unified in a follow-up.
      const config = {
        provider: ev.to_model.split("/")[0],
        modelId: ev.to_model.split("/")[1],
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
      // A system-injected reminder — like pi's role:"custom" message with
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
      // The 5 interrogative_types each map to a pilot card kind. The card's
      // requestId == the daemon's interrogative_id, so respondUi can look up the
      // pending metadata to build the InterrogativeResponse. An unrecognized type
      // returns a notify + null pending (no registerInterrogative effect).
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
      // The permission MODE changed (standard/bypass/autonomous). Surface it as
      // a notify so the operator sees the daemon's mode flipped (e.g. an
      // autonomous classifier took over approvals). The mode SWITCHER UI (the
      // POST /permission-monitor control) is a Chunk 5 Settings concern; this is
      // just the ambient "the daemon's mode changed" signal.
      const fromMode = ev.from_monitor.type;
      const toMode = ev.to_monitor.type;
      return events([
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `perm-mode-${meta.timestamp}`,
            message: `Permission mode: ${fromMode} → ${toMode}`,
            level: "info",
          },
        },
      ]);
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
