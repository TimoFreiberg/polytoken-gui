// The folded, render-ready view of a session. The server holds the authoritative
// copy; clients fold the same event stream into an identical local copy. On
// (re)connect the server ships a full SessionState snapshot which the client
// adopts wholesale, then resumes incremental folding.

import {
  type HostUiRequest,
  isDialogRequest,
  type SessionConfig,
  type SessionDriverEvent,
  type SessionQueuedMessage,
  type SessionRef,
  type SessionStatus,
} from "./session-driver.js";

export interface UserItem {
  readonly kind: "user";
  id: string;
  text: string;
}
export interface AssistantItem {
  readonly kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
}
export type ToolStatus = "running" | "ok" | "error";
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
}
export interface NoticeItem {
  readonly kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  text: string;
}
export type TranscriptItem = UserItem | AssistantItem | ToolItem | NoticeItem;

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

function closeOpenAssistant(items: TranscriptItem[]): void {
  const a = openAssistant(items);
  if (a) a.streaming = false;
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
      state.queued = s.queuedMessages ? [...s.queuedMessages] : [];
      if (ev.type === "runCompleted") closeOpenAssistant(state.items);
      return state;
    }

    case "userMessage": {
      closeOpenAssistant(state.items);
      state.items.push({ kind: "user", id: ev.id, text: ev.text });
      return state;
    }

    case "queuedMessageStarted": {
      // The queued message is now being delivered; surface it as a user turn.
      closeOpenAssistant(state.items);
      state.items.push({
        kind: "user",
        id: ev.message.id,
        text: ev.message.text,
      });
      state.queued = state.queued.filter((q) => q.id !== ev.message.id);
      return state;
    }

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
      }
      return state;
    }

    case "runFailed": {
      closeOpenAssistant(state.items);
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
      state.items.push({
        kind: "notice",
        id: `compat-${ev.timestamp}`,
        level: "warning",
        text: `Extension capability "${ev.issue.capability}" is terminal-only: ${ev.issue.message}`,
      });
      return state;
    }

    case "sessionClosed": {
      closeOpenAssistant(state.items);
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
