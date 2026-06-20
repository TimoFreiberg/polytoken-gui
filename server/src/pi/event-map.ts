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
import { queueMessages } from "./queue-map.js";

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
  /** pi tree entry ids for the turn that just completed (this turn's user prompt + the
   *  turn-final assistant message), read from the live session at agent_end — the first
   *  moment they're persisted (the id can't ride the streaming deltas). Stamped onto
   *  runCompleted so the reducer lights up the "branch from here" buttons on the live
   *  transcript. Optional: mappers/tests without a live session omit it. */
  turnEntryIds?(): { userEntryId?: string; assistantEntryId?: string };
}

function asText(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Flatten a custom message's content (string, or pi's content-block array) to the
 *  plain text we surface. Images become a placeholder; mirrors history-map.contentToText
 *  so live and reloaded transcripts read identically. */
function customContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? ((b as { text?: string }).text ?? "")
        : b &&
            typeof b === "object" &&
            (b as { type?: string }).type === "image"
          ? "[image]"
          : "",
    )
    .join("");
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
      // The turn's messages have persisted by agent_end, so their tree entry ids are
      // now readable — carry them so the reducer can backfill the branch handles onto
      // the live transcript (they couldn't ride the streaming deltas).
      const ids = ctx.turnEntryIds?.() ?? {};
      return [
        {
          ...meta,
          type: "runCompleted",
          snapshot: ctx.snapshot("idle"),
          userEntryId: ids.userEntryId,
          assistantEntryId: ids.assistantEntryId,
        },
      ];
    }

    case "message_start": {
      // An extension-injected custom message (pi's sendMessage). Surfaced as a turn
      // boundary so the run it triggers (e.g. a journal nudge) gets its own turn
      // instead of collapsing the prior turn's final response into "work". We map on
      // message_start (not message_end) so the non-triggerTurn start+end pair can't
      // double-emit. Non-custom message_start (user/assistant/toolResult) is ignored:
      // assistant text arrives via message_update deltas, and user turns are
      // synthesized on pilot's own prompt() send path.
      const msg = ev.message as {
        role?: string;
        customType?: string;
        content?: unknown;
        display?: boolean;
        timestamp?: number;
      };
      if (msg.role !== "custom") return [];
      return [
        {
          ...meta,
          type: "customMessage",
          id: `inject-${meta.timestamp}`,
          customType: msg.customType ?? "",
          text: customContentToText(msg.content),
          display: msg.display !== false,
        },
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

    case "queue_update":
      return [
        {
          ...meta,
          type: "queueUpdated",
          messages: queueMessages(ev.steering, ev.followUp, meta.timestamp),
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
      // turn_start/turn_end, compaction_end, auto_retry_end,
      // thinking_level_changed, message_end, and assistant start/done are
      // intentionally not surfaced — the reducer derives what it needs from deltas.
      // (message_start IS surfaced, but only for role:"custom" — see above.)
      return [];
  }
}
