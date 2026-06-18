// Pure mapping from pi's AgentSessionEvent stream to pilot's SessionDriverEvent
// stream. This is the testable heart of the real driver — given a pi event and a
// little context, it returns zero or more pilot events to fold + broadcast.
//
// Shapes grounded in pi source:
//   AgentSessionEvent: core/agent-session.ts:124
//   AssistantMessageEvent (text_delta/thinking_delta/...): packages/ai/src/types.ts
//   tool_execution_*: docs/rpc.md

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  SessionDriverEvent,
  SessionRef,
  SessionSnapshot,
  SessionStatus,
} from "@pilot/protocol";

export interface MapCtx {
  ref: SessionRef;
  now(): string;
  /** Human label + description for a tool name, resolved from session.getAllTools(). */
  toolMeta(name: string): { label?: string; description?: string };
  /** Build a snapshot reflecting the current title/config at a given status. */
  snapshot(status: SessionStatus): SessionSnapshot;
  /** The session's live run status. Used by out-of-band events (a rename) whose snapshot
   *  must reflect reality, not assume idle — an idle snapshot mid-turn closes the
   *  streaming bubble and clears the running indicator. */
  liveStatus(): SessionStatus;
}

function asText(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Map one pi event to zero or more pilot driver events. */
export function mapPiEvent(
  ev: AgentSessionEvent,
  ctx: MapCtx,
): SessionDriverEvent[] {
  const meta = { sessionRef: ctx.ref, timestamp: ctx.now() };

  switch (ev.type) {
    case "agent_start":
      return [
        { ...meta, type: "sessionUpdated", snapshot: ctx.snapshot("running") },
      ];

    case "agent_end": {
      // willRetry = overflow/retryable auto-retry; the turn isn't really done yet.
      if (ev.willRetry) return [];
      // An API error (overloaded, rate limit, auth, quota, network drop, …) is NOT
      // delivered as a message_update "error" event: agent-core consumes the provider
      // error into a message_end, and the turn's FINAL assistant message carries
      // stopReason "error" + errorMessage (agent-loop.ts case "error"). Mirror pi's TUI,
      // which surfaces message.errorMessage. Scan from the end for the last assistant
      // message (skipping trailing toolResults) and fail the run if it errored.
      for (let i = ev.messages.length - 1; i >= 0; i--) {
        const m = ev.messages[i];
        if (!m || m.role !== "assistant") continue;
        if (m.stopReason === "error")
          return [
            {
              ...meta,
              type: "runFailed",
              error: {
                message: m.errorMessage ?? "The model returned an error",
              },
            },
          ];
        break; // last assistant turn was fine → normal completion
      }
      return [
        { ...meta, type: "runCompleted", snapshot: ctx.snapshot("idle") },
      ];
    }

    case "message_update": {
      const a = ev.assistantMessageEvent;
      if (a.type === "text_delta")
        return [
          { ...meta, type: "assistantDelta", text: a.delta, channel: "text" },
        ];
      if (a.type === "thinking_delta")
        return [
          {
            ...meta,
            type: "assistantDelta",
            text: a.delta,
            channel: "thinking",
          },
        ];
      // NB: an API/provider error is NOT surfaced here. agent-core never re-emits the
      // provider's `{type:"error"}` as a message_update — it folds it into a message_end
      // whose final assistant message has stopReason "error". We fail the run from
      // `agent_end` (above), the single choke point that also carries willRetry.
      return [];
    }

    case "tool_execution_start": {
      const m = ctx.toolMeta(ev.toolName);
      return [
        {
          ...meta,
          type: "toolStarted",
          callId: ev.toolCallId,
          toolName: ev.toolName,
          input: ev.args,
          label: m.label,
          description: m.description,
        },
      ];
    }

    case "tool_execution_update":
      return [
        {
          ...meta,
          type: "toolUpdated",
          callId: ev.toolCallId,
          text: asText(ev.partialResult),
        },
      ];

    case "tool_execution_end":
      return [
        {
          ...meta,
          type: "toolFinished",
          callId: ev.toolCallId,
          success: !ev.isError,
          output: ev.result,
        },
      ];

    case "session_info_changed":
      // A rename (or other info change) can land mid-turn; reflect the live status so
      // it doesn't masquerade as an idle turn boundary.
      return [
        {
          ...meta,
          type: "sessionUpdated",
          snapshot: ctx.snapshot(ctx.liveStatus()),
        },
      ];

    case "auto_retry_start":
      return [
        {
          ...meta,
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `retry-${meta.timestamp}`,
            message: `Retrying (attempt ${ev.attempt}/${ev.maxAttempts}): ${ev.errorMessage}`,
            level: "warning",
          },
        },
      ];

    case "compaction_start":
      return [
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
      ];

    default:
      // turn_start/turn_end, queue_update, compaction_end, auto_retry_end,
      // thinking_level_changed, message_start/end, and assistant start/done are
      // intentionally not surfaced — the reducer derives what it needs from deltas.
      return [];
  }
}
