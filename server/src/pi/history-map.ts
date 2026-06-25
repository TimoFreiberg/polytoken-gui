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
import { imagesFromContent, textFromContent } from "./content.js";

/**
 * Roles `historyToEvents` knows how to render. This is the runtime shape guard at
 * the pi-internal boundary: `session.messages` reaches us through a structural cast
 * (`as unknown as readonly HistoryMessage[]` in pi-driver.ts), so a pi version bump
 * that adds a new renderable role would compile fine but silently drop those messages
 * from reloaded transcripts (the `default: break` below). {@link findUnknownHistoryRoles}
 * + {@link warnUnknownHistoryRole} surface drift LOUD instead — a failing canary test
 * (history-map-shape.test.ts) and a per-role process warning catch it.
 *
 * Keep in sync with the `switch (m.role)` cases in {@link historyToEvents}.
 */
export const KNOWN_HISTORY_ROLES = [
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "compactionSummary",
  "branchSummary",
] as const;

const KNOWN_ROLE_SET = new Set<string>(KNOWN_HISTORY_ROLES);

/** Roles in `messages` that {@link historyToEvents} would silently drop. */
export function findUnknownHistoryRoles(
  messages: readonly { role: string }[],
): string[] {
  const unknown: string[] = [];
  for (const m of messages) {
    if (!KNOWN_ROLE_SET.has(m.role) && !unknown.includes(m.role))
      unknown.push(m.role);
  }
  return unknown;
}

/** Warn once per unknown role per process so a pi shape drift is diagnosable, not
 *  silent. Dedup avoids log spam when a whole reloaded transcript carries the new role. */
const warnedRoles = new Set<string>();
export function warnUnknownHistoryRole(role: string): void {
  if (warnedRoles.has(role)) return;
  warnedRoles.add(role);
  console.warn(
    `[pilot] history-map: unknown message role "${role}" — dropped from reloaded transcript. ` +
      `This usually means a pi version bump added a renderable role; add a case to historyToEvents.`,
  );
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments?: unknown }
  // pi persists image blocks with their base64 data + mimeType (pi-ai ImageContent);
  // the runtime session.messages carry them even though older callers only read `type`.
  | { type: "image"; data?: string; mimeType?: string }
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
  // custom (extension-injected sendMessage)
  readonly customType?: string;
  readonly display?: boolean;
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
  // pi tree entry ids aligned to `messages` (driver-correlated; see branch-ids.ts).
  // Carried onto the userMessage / assistantDelta events so a replayed transcript item
  // can offer "branch from here". `undefined` per slot → that item gets no branch handle.
  entryIds?: readonly (string | undefined)[],
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

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const entryId = entryIds?.[i];
    switch (m.role) {
      case "user":
        out.push({
          ...meta(m.timestamp),
          type: "userMessage",
          id: `u-${seq}`,
          // textFromContent (not contentToText): the image renders as a thumbnail from
          // the typed `images` field, so don't also leak a "[image]" placeholder into text.
          text: textFromContent(m.content),
          images: imagesFromContent(m.content),
          entryId,
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
              entryId,
            });
          else if (b.type === "thinking")
            out.push({
              ...meta(m.timestamp),
              type: "assistantDelta",
              text: (b as { thinking: string }).thinking,
              channel: "thinking",
              entryId,
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
          // textFromContent: image blocks are surfaced via the typed `images` field and
          // rendered as <img>, so the output text shouldn't carry a "[image]" placeholder.
          output: textFromContent(m.content),
          images: imagesFromContent(m.content),
        });
        break;

      case "custom":
        // An extension-injected custom message (pi's sendMessage). Surface it as a
        // turn boundary so a reloaded transcript splits the run it triggered exactly
        // as the live path does — otherwise the prior turn's final response collapses
        // into the nudge run's work block. `display:false` still splits but renders
        // nothing (the robustness net).
        out.push({
          ...meta(m.timestamp),
          type: "customMessage",
          id: `inject-${seq}`,
          customType: m.customType ?? "",
          text: contentToText(m.content),
          display: m.display !== false,
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

      // Unknown roles carry no transcript-renderable content here — skip, but
      // warn LOUD (once per role per process) so a pi version bump that introduces
      // a new renderable role is diagnosable instead of silently dropping messages
      // from reloaded transcripts. The cast `session.messages as unknown as
      // readonly HistoryMessage[]` (pi-driver.ts) is structural; this guard is the
      // only thing that surfaces shape drift at runtime. See history-map-shape.test.ts.
      default: {
        warnUnknownHistoryRole(m.role);
        break;
      }
    }
  }

  // Close any still-open assistant bubble and settle to idle, exactly as a finished
  // live turn would (runCompleted is the only event that closes a streaming bubble).
  out.push({ ...meta(), type: "runCompleted", snapshot: ctx.idleSnapshot });
  return out;
}
