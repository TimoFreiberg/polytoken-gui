// The folded, render-ready view of a session. The server holds the authoritative
// copy; clients fold the same event stream into an identical local copy. On
// (re)connect the server ships a full SessionState snapshot which the client
// adopts wholesale, then resumes incremental folding.

import {
  type HostUiRequest,
  type ImageContent,
  isDialogRequest,
  type SessionConfig,
  type SessionDriverEvent,
  type SessionQueuedMessage,
  type SessionRef,
  type SessionStatus,
  type SessionUsage,
} from "./session-driver.js";

export interface UserItem {
  readonly kind: "user";
  id: string;
  text: string;
  /** Image attachments, if any. */
  images?: readonly ImageContent[];
  /** ISO timestamp of when this user turn was sent. */
  ts?: string;
  /** pi's tree entry id for this prompt — the handle "branch from this prompt" sends to
   *  the server (→ navigateTree). Distinct from `id` (a synthetic {#each} key); undefined
   *  until the live backfill / replay supplies it, in which case no branch button shows. */
  entryId?: string;
  /** Client-only delivery state for an optimistic prompt row. Authoritative server
   *  transcript items omit it; the client overlays pending outbox entries at render time. */
  delivery?: "sending" | "offline" | "rejected";
  deliveryError?: string;
}
export interface AssistantItem {
  readonly kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
  /** ISO timestamp of when this assistant turn began. */
  ts?: string;
  /** pi's tree entry id for this turn — the handle "branch from here" sends to the server.
   *  Set on the turn-final assistant; absent → no branch button. See UserItem.entryId. */
  entryId?: string;
  /** ISO timestamp (or epoch-ms string) of when the turn settled — stamped on the
   *  turn-final assistant when a non-running snapshot closes it (runCompleted, or an
   *  idle sessionUpdated/sessionClosed). With `ts` it yields the turn's wall-clock
   *  duration ("Worked for Ns"). Absent while streaming, or when the turn ended on a
   *  tool / error rather than an assistant message. */
  completedAt?: string;
}
export type ToolStatus = "running" | "ok" | "error" | "interrupted";
export interface ToolItem {
  readonly kind: "tool";
  id: string; // callId
  name: string;
  label?: string;
  description?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
  progress?: number;
  status: ToolStatus;
  /** ISO timestamp (or epoch-ms string) of the `toolStarted` event — when the call began. */
  startedAt?: string;
  /** ISO timestamp of the `toolFinished` event — when it settled. With `startedAt`, the
   *  card derives an elapsed-duration badge. Absent while still running. */
  finishedAt?: string;
}
export interface NoticeItem {
  readonly kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  text: string;
}
/** An extension-injected custom message (pi's `sendMessage`). Folded from a
 *  `customMessage` event. Acts as a turn boundary (see transcript-view.groupTurns):
 *  the run it triggered gets its own turn instead of gluing onto the prior one.
 *  `display:false` items render nothing but still split the turn. */
export interface InjectItem {
  readonly kind: "inject";
  id: string;
  customType: string;
  text: string;
  display: boolean;
  /** ISO timestamp (or epoch-ms string) of when the message was injected. */
  ts?: string;
}
export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | NoticeItem
  | InjectItem;

export interface AmbientWidget {
  key: string;
  lines: string[];
  placement: "aboveComposer" | "belowComposer";
}

export interface SessionState {
  ref: SessionRef | null;
  title: string;
  status: SessionStatus;
  config: SessionConfig;
  /** Context-window fill for the active model; undefined until a snapshot carries it
   *  (or when the model exposes no context window). Drives the composer's meter. */
  usage?: SessionUsage;
  items: TranscriptItem[];
  /** Blocking dialogs awaiting a response, in arrival order. */
  pendingApprovals: HostUiRequest[];
  ambient: {
    statuses: Record<string, string>;
    widgets: Record<string, AmbientWidget>;
    title?: string;
  };
  queued: SessionQueuedMessage[];
}

export function initialSessionState(): SessionState {
  return {
    ref: null,
    title: "",
    status: "idle",
    config: {},
    items: [],
    pendingApprovals: [],
    ambient: { statuses: {}, widgets: {} },
    queued: [],
  };
}

function lastItem(items: TranscriptItem[]): TranscriptItem | undefined {
  return items[items.length - 1];
}

/** True if there is an assistant item currently accumulating deltas. */
function openAssistant(items: TranscriptItem[]): AssistantItem | undefined {
  const last = lastItem(items);
  return last && last.kind === "assistant" && last.streaming ? last : undefined;
}

/** Close the open assistant bubble (if any). When `completedAt` is given — i.e. the
 *  turn actually ended, not just got interrupted by a new item — stamp it so the UI
 *  can derive the turn's "Worked for Ns" duration. Interruption closers (toolStarted,
 *  userMessage, a mid-turn notify) pass nothing: that bubble isn't the turn-final one. */
function closeOpenAssistant(
  items: TranscriptItem[],
  completedAt?: string,
): void {
  const a = openAssistant(items);
  if (a) {
    a.streaming = false;
    if (completedAt) a.completedAt = completedAt;
  }
}

/** Backfill a pi tree entry id onto the most recent item of `kind` (the live-path
 *  branch handle — see RunCompletedEvent). The most recent assistant item is the
 *  turn-final one; the most recent user item is the turn's prompt. Idempotent: a
 *  re-fold stamps the same id. */
function stampLastEntryId(
  items: TranscriptItem[],
  kind: "user" | "assistant",
  entryId: string,
): void {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    // Literal comparisons so TS narrows `it` to the item type that has `entryId`.
    if (kind === "user" && it.kind === "user") {
      it.entryId = entryId;
      return;
    }
    if (kind === "assistant" && it.kind === "assistant") {
      it.entryId = entryId;
      return;
    }
  }
}

/** Settle tool cards that never received a matching toolFinished event. This only
 *  runs at authoritative turn boundaries: an idle sessionUpdated can be a transient
 *  mid-tool snapshot (pi's isStreaming briefly reads false), while runCompleted,
 *  runFailed, and sessionClosed guarantee that the tool is no longer executing. */
function interruptRunningTools(
  items: TranscriptItem[],
  finishedAt: string,
): void {
  for (const item of items) {
    if (item.kind === "tool" && item.status === "running") {
      item.status = "interrupted";
      item.finishedAt = finishedAt;
    }
  }
}

/**
 * Fold one driver event into state. MUTATES `state` and returns it — callers that
 * need immutability (Svelte reactivity) should clone first or reassign the result.
 * Mutation keeps the hot streaming path allocation-free; correctness comes from
 * the server and client folding the identical event order.
 */
export function foldEvent(
  state: SessionState,
  ev: SessionDriverEvent,
): SessionState {
  switch (ev.type) {
    case "sessionOpened":
    case "sessionUpdated":
    case "runCompleted": {
      const s = ev.snapshot;
      state.ref = s.ref;
      state.title = s.title;
      state.status = s.status;
      if (s.config) state.config = s.config;
      // Only overwrite when the snapshot carries usage, so a usage-less snapshot
      // (e.g. the mock's abort) doesn't blank a known meter value. A defined usage
      // with tokens:null is still meaningful (window known, count pending).
      if (s.usage) state.usage = s.usage;
      // Queue changes have their own authoritative `queueUpdated` event. A snapshot that
      // carries the queue replaces it (including []); an older/partial snapshot that omits
      // the field must not erase live queue state.
      if (s.queuedMessages) state.queued = [...s.queuedMessages];
      // Close any open assistant when the turn ends. runCompleted always ends a
      // turn; a sessionUpdated/runCompleted snapshot whose status is no longer
      // "running" (idle or failed) also ends it. Without this, an idle
      // transition that arrives only as a sessionUpdated leaves the assistant
      // item streaming:true forever (the stray blinking caret bug).
      if (s.status !== "running") closeOpenAssistant(state.items, ev.timestamp);
      // Unlike sessionUpdated, runCompleted is an authoritative turn boundary.
      // Settle any tool whose result was never persisted/emitted so replay cannot
      // leave a historical card "running" forever.
      if (ev.type === "runCompleted") {
        interruptRunningTools(state.items, ev.timestamp);
        // Live-path branch handles: pi only knows the just-completed turn's entry ids
        // now that its messages have persisted (they can't ride the deltas). Stamp them
        // onto the turn-final assistant + this turn's user item so the "branch from here"
        // buttons light up without a reload. No-op on replay (ids ride the per-message
        // events there) and when the fields are absent.
        if (ev.assistantEntryId)
          stampLastEntryId(state.items, "assistant", ev.assistantEntryId);
        if (ev.userEntryId)
          stampLastEntryId(state.items, "user", ev.userEntryId);
      }
      return state;
    }

    case "userMessage": {
      closeOpenAssistant(state.items);
      state.items.push({
        kind: "user",
        id: ev.id,
        text: ev.text,
        images: ev.images,
        ts: ev.timestamp,
        // entryId rides the event on the replay path; live emits omit it (backfilled at
        // runCompleted). undefined is fine — the branch button just stays hidden.
        entryId: ev.entryId,
      });
      return state;
    }

    case "customMessage": {
      // An injected custom message closes any open assistant bubble (same as a user
      // message / tool start) and lands as its own item so groupTurns can split the
      // turn here. No completedAt: the prior runCompleted already stamped the real
      // turn-final assistant; this is just the boundary marker.
      closeOpenAssistant(state.items);
      state.items.push({
        kind: "inject",
        id: ev.id,
        customType: ev.customType,
        text: ev.text,
        display: ev.display,
        ts: ev.timestamp,
      });
      return state;
    }

    case "queuedMessageStarted": {
      // The queued message is now being delivered; surface it as a user turn.
      closeOpenAssistant(state.items);
      state.items.push({
        kind: "user",
        id: ev.message.id,
        text: ev.message.text,
        ts: ev.message.createdAt ?? ev.timestamp,
      });
      state.queued = state.queued.filter((q) => q.id !== ev.message.id);
      return state;
    }

    case "queueUpdated":
      state.queued = [...ev.messages];
      return state;

    case "assistantDelta": {
      const open = openAssistant(state.items);
      const target =
        open ??
        (() => {
          const a: AssistantItem = {
            kind: "assistant",
            id: `a-${ev.timestamp}-${state.items.length}`,
            text: "",
            thinking: "",
            streaming: true,
            ts: ev.timestamp,
            // Stamp the branch handle when this delta opens a NEW bubble (replay path).
            // All deltas of one assistant message carry the same entryId, so a
            // tool-interleaved message's later bubbles inherit the correct node too.
            entryId: ev.entryId,
          };
          state.items.push(a);
          return a;
        })();
      if (ev.channel === "thinking") target.thinking += ev.text;
      else target.text += ev.text;
      return state;
    }

    case "toolStarted": {
      closeOpenAssistant(state.items);
      state.items.push({
        kind: "tool",
        id: ev.callId,
        name: ev.toolName,
        label: ev.label,
        description: ev.description,
        input: ev.input,
        status: "running",
        startedAt: ev.timestamp,
      });
      return state;
    }

    case "toolUpdated": {
      const t = state.items.find(
        (i): i is ToolItem => i.kind === "tool" && i.id === ev.callId,
      );
      if (t) {
        if (ev.text !== undefined) t.text = ev.text;
        if (ev.progress !== undefined) t.progress = ev.progress;
      }
      return state;
    }

    case "toolFinished": {
      const t = state.items.find(
        (i): i is ToolItem => i.kind === "tool" && i.id === ev.callId,
      );
      if (t) {
        t.status = ev.success ? "ok" : "error";
        t.output = ev.output;
        t.finishedAt = ev.timestamp;
      }
      return state;
    }

    case "usageUpdated": {
      // Mid-turn context-meter refresh (hub timer). Touches ONLY usage so it can't
      // disturb the streaming transcript / queued messages / config.
      state.usage = ev.usage;
      return state;
    }

    case "runFailed": {
      closeOpenAssistant(state.items);
      interruptRunningTools(state.items, ev.timestamp);
      state.status = "failed";
      state.items.push({
        kind: "notice",
        id: `err-${ev.timestamp}`,
        level: "error",
        text: ev.error.message,
      });
      return state;
    }

    case "hostUiRequest": {
      const req = ev.request;
      if (isDialogRequest(req)) {
        if (
          !state.pendingApprovals.some((p) => p.requestId === req.requestId)
        ) {
          state.pendingApprovals.push(req);
        }
        return state;
      }
      // fire-and-forget ambient UI
      switch (req.kind) {
        case "status":
          if (req.text) state.ambient.statuses[req.key] = req.text;
          else delete state.ambient.statuses[req.key];
          break;
        case "widget":
          if (req.lines && req.lines.length > 0) {
            state.ambient.widgets[req.key] = {
              key: req.key,
              lines: [...req.lines],
              placement: req.placement ?? "aboveComposer",
            };
          } else {
            delete state.ambient.widgets[req.key];
          }
          break;
        case "title":
          state.ambient.title = req.title;
          break;
        case "notify":
          // A notice is a transcript item, so it ends any open assistant bubble —
          // same as toolStarted/userMessage. Without this, a mid-turn notify
          // (compaction/auto-retry) orphans the in-progress bubble: a later delta
          // can't reuse it (no longer the last item) and starts a fresh bubble,
          // leaving the orphan streaming:true forever (the stray blinking caret).
          closeOpenAssistant(state.items);
          state.items.push({
            kind: "notice",
            id: req.requestId,
            level: req.level ?? "info",
            text: req.message,
          });
          break;
        case "reset":
          state.ambient = { statuses: {}, widgets: {} };
          break;
        case "editorText":
          // prefill belongs to the per-client composer; ignored in shared state
          break;
      }
      return state;
    }

    case "hostUiResolved": {
      state.pendingApprovals = state.pendingApprovals.filter(
        (p) => p.requestId !== ev.requestId,
      );
      return state;
    }

    case "extensionCompatibilityIssue": {
      closeOpenAssistant(state.items);
      state.items.push({
        kind: "notice",
        id: `compat-${ev.timestamp}`,
        level: "warning",
        text: `Extension capability "${ev.issue.capability}" is terminal-only: ${ev.issue.message}`,
      });
      return state;
    }

    case "sessionClosed": {
      closeOpenAssistant(state.items, ev.timestamp);
      interruptRunningTools(state.items, ev.timestamp);
      state.status = ev.reason === "failed" ? "failed" : "idle";
      return state;
    }
  }
  return state;
}

/** Convenience: fold a batch (used to rebuild state from an event log). */
export function foldAll(
  events: readonly SessionDriverEvent[],
  start: SessionState = initialSessionState(),
): SessionState {
  for (const ev of events) foldEvent(start, ev);
  return start;
}
