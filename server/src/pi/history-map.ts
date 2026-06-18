// Pure mapping from a pi session's stored messages to pilot's SessionDriverEvent
// stream, so a resumed/reloaded session rebuilds the SAME transcript the live path
// would have produced (fold these with foldAll). This is the "restore on reload"
// half of D13: pi's on-disk .jsonl is authoritative; pilot's in-memory state is a
// derived cache rebuilt from it.
//
// Input is typed structurally against pi's documented session-format.md (v3) rather
// than importing pi's AgentMessage union — those message/content types aren't
// re-exported from @earendil-works/pi-coding-agent (they live in pi-ai /
// pi-agent-core). session.messages (AgentMessage[]) is structurally assignable to
// HistoryMessage[]. Keeping it structural also keeps this core trivially unit-testable.

import type {
  SessionDriverEvent,
  SessionRef,
  SessionSnapshot,
} from "@pilot/protocol";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments?: unknown }
  | { type: "image" }
  | { type: string };

/** Narrow structural view of a stored pi message (see pi docs/session-format.md). */
export interface HistoryMessage {
  readonly role: string;
  readonly content?: string | ContentBlock[];
  // Per-message wall-clock time (Unix ms). pi-ai's UserMessage/AssistantMessage/
  // ToolResultMessage and the custom message types all carry this; we surface it so
  // a reloaded transcript shows real times instead of synthetic ordering markers.
  readonly timestamp?: number;
  // assistant: a failed turn (API error) carries these instead of content
  readonly stopReason?: string;
  readonly errorMessage?: string;
  // toolResult
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  // bashExecution
  readonly command?: string;
  readonly output?: string;
  readonly exitCode?: number;
  // compactionSummary / branchSummary
  readonly summary?: string;
}

export interface HistoryMapCtx {
  ref: SessionRef;
  /** Snapshot to attach to the closing runCompleted (idle, derived by the driver). */
  idleSnapshot: SessionSnapshot;
  toolMeta(name: string): { label?: string; description?: string };
}

/** Flatten message content to plain text the transcript renders (images -> placeholder). */
export function contentToText(
  content: string | ContentBlock[] | undefined,
): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) =>
      b.type === "text"
        ? (b as { text: string }).text
        : b.type === "image"
          ? "[image]"
          : "",
    )
    .join("");
}

/**
 * Convert stored messages to the pilot events that reproduce them. Returns [] for an
 * empty history (the driver's own sessionOpened already establishes idle state).
 * Mirrors event-map.ts exactly so replayed and live transcripts are identical — e.g.
 * a toolCall block becomes toolStarted, its later toolResult becomes toolFinished,
 * and assistant bubbles are separated by the same toolStarted/userMessage closes.
 */
export function historyToEvents(
  messages: readonly HistoryMessage[],
  ctx: HistoryMapCtx,
): SessionDriverEvent[] {
  if (messages.length === 0) return [];

  let seq = 0;
  // Prefer pi's stored per-message timestamp so reloaded transcripts show real times;
  // fall back to a synthetic `h-N` ordering marker for messages without one. seq still
  // advances every call so the `u-${seq}`/`bash-${seq}`/`summary-${seq}` ids stay unique.
  const meta = (ts?: number) => {
    const marker = `h-${seq++}`;
    return { sessionRef: ctx.ref, timestamp: ts != null ? String(ts) : marker };
  };
  const out: SessionDriverEvent[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push({
          ...meta(m.timestamp),
          type: "userMessage",
          id: `u-${seq}`,
          text: contentToText(m.content),
        });
        break;

      case "assistant": {
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (b.type === "text")
            out.push({
              ...meta(m.timestamp),
              type: "assistantDelta",
              text: (b as { text: string }).text,
              channel: "text",
            });
          else if (b.type === "thinking")
            out.push({
              ...meta(m.timestamp),
              type: "assistantDelta",
              text: (b as { thinking: string }).thinking,
              channel: "thinking",
            });
          else if (b.type === "toolCall") {
            const call = b as { id: string; name: string; arguments?: unknown };
            const tm = ctx.toolMeta(call.name);
            out.push({
              ...meta(m.timestamp),
              type: "toolStarted",
              callId: call.id,
              toolName: call.name,
              input: call.arguments,
              label: tm.label,
              description: tm.description,
            });
          }
        }
        // A turn that ended in an API error persists with stopReason "error" and an
        // errorMessage (often with empty content). Surface it as an inline error
        // notice so a reloaded/refocused session shows the failure the live path
        // raised via runFailed — not a silently empty assistant bubble.
        if (m.stopReason === "error")
          out.push({
            ...meta(m.timestamp),
            type: "hostUiRequest",
            request: {
              kind: "notify",
              requestId: `err-${seq}`,
              message: m.errorMessage ?? "The model returned an error",
              level: "error",
            },
          });
        break;
      }

      case "toolResult":
        out.push({
          ...meta(m.timestamp),
          type: "toolFinished",
          callId: m.toolCallId ?? "",
          success: !m.isError,
          output: contentToText(m.content),
        });
        break;

      case "bashExecution":
        // The `!`-bash affordance result — surface as a notice (no tool card pairing).
        out.push({
          ...meta(m.timestamp),
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `bash-${seq}`,
            message: `$ ${m.command ?? ""}\n${m.output ?? ""}`,
            level: m.exitCode ? "warning" : "info",
          },
        });
        break;

      case "compactionSummary":
      case "branchSummary":
        out.push({
          ...meta(m.timestamp),
          type: "hostUiRequest",
          request: {
            kind: "notify",
            requestId: `summary-${seq}`,
            message: m.summary ?? "",
            level: "info",
          },
        });
        break;

      // custom / unknown roles carry no transcript-renderable content here — skip.
      default:
        break;
    }
  }

  // Close any still-open assistant bubble and settle to idle, exactly as a finished
  // live turn would (runCompleted is the only event that closes a streaming bubble).
  out.push({ ...meta(), type: "runCompleted", snapshot: ctx.idleSnapshot });
  return out;
}
