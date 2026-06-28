// Folding polytoken's `GET /history` items into pilot's `SessionDriverEvent[]` —
// the REPLAY/seed path (the inverse of event-map.ts's live stream fold).
//
// `openSession`/`reloadSession` spawn a daemon and must deliver the session's
// existing transcript to the hub atomically: a `sessionOpened` snapshot + the
// replayed history, so the client renders the full conversation on focus/reload
// (the hub resets + folds these, never via `subscribe`).
//
// polytoken's history is a linear event log (no branch DAG — spike §7), and
// `KnownSessionHistoryItem` is a tagged union on `type`. The renderable kinds for
// a transcript are: `user` (content + prompt_id), `assistant` (blocks[] +
// prompt_id), and `tool_result` (call_id + content + is_error + prompt_id).
// Others (session_lifecycle, model_switch, state_update, facet_switch,
// compaction_fencepost, system_reminder, classifier_decision, context_cleared,
// image_reference) are metadata, not transcript rows — they're skipped on the
// replay path exactly as the live event-fold skips or handles them ambiently.
//
// This mirrors pi's historyToEvents: a pure function over a typed input, so it's
// unit-testable without a daemon. Tool input comes from the assistant's
// `tool_use` blocks (not a separate tool_call event in history), so we emit
// `toolStarted` inline as we walk the assistant blocks, then pair the later
// `tool_result` by `call_id`.

import type {
  ImageContent,
  SessionDriverEvent,
  SessionRef,
} from "@pilot/protocol";
import type { components } from "./wire-types.js";

type S = components["schemas"];
/** A known history item (the discriminated union). Unknown variants (future
 *  daemon kinds) arrive as `unknown` and are skipped — never crash the seed. */
export type HistoryItem = S["KnownSessionHistoryItem"] | (S["SessionHistoryItem"] & unknown);
export type ContentBlock = S["ContentBlock"];
export type ToolResultContent = S["ToolResultContent"];

/** Lift image content from a tool_result's `content` (ToolResultContent has three
 *  variants: {text}, {blocks}, {image}). Reuses the live path's extractToolResult
 *  shape so the reloaded tool card matches the live one. */
function liftToolResult(
  content: ToolResultContent | null | undefined,
  is_error?: boolean | null,
): { output: unknown; images?: readonly ImageContent[]; success: boolean } {
  const success = !is_error;
  if (!content) return { output: undefined, success };
  // Image variant: {image: {data, media_type, text_fallback}}
  if (
    typeof content === "object" &&
    "image" in content &&
    content.image &&
    typeof content.image === "object"
  ) {
    const img = content.image as {
      data?: string;
      media_type?: string;
      text_fallback?: string;
    };
    if (typeof img.data === "string" && typeof img.media_type === "string") {
      return {
        output: img.text_fallback ?? "",
        images: [{ type: "image", data: img.data, mimeType: img.media_type }],
        success,
      };
    }
  }
  // Text variant: {text: string}
  if (typeof content === "object" && "text" in content) {
    return { output: content.text, success };
  }
  // Blocks variant: {blocks: ContentBlock[]} — join text blocks
  if (typeof content === "object" && "blocks" in content && Array.isArray(content.blocks)) {
    const text = content.blocks
      .filter(
        (b) =>
          b && typeof b === "object" && (b as { type?: string }).type === "text",
      )
      .map((b) => (b as { text: string }).text)
      .join("");
    return { output: text, success };
  }
  return { output: undefined, success };
}

/** Build a stable event id for a replayed item. polytoken history items carry a
 *  `meta.item_id` (a stable id) we can thread onto pilot's events where the field
 *  exists; otherwise a synthetic seq-based id keeps events unique. */
interface HistoryMapCtx {
  ref: SessionRef;
}

/** Fold `GET /history` items into `SessionDriverEvent[]`. Pure — no I/O, no daemon.
 *  Items are rendered in order; `assistant` blocks emit `assistantDelta` (text +
 *  thinking) and `toolStarted` (tool_use) inline, and a later `tool_result` pairs
 *  by `call_id`. Non-transcript kinds (lifecycle, model_switch, …) are skipped. */
export function historyToSeedEvents(
  items: readonly HistoryItem[],
  ctx: HistoryMapCtx,
): SessionDriverEvent[] {
  if (items.length === 0) return [];
  const { ref } = ctx;
  const out: SessionDriverEvent[] = [];
  let seq = 0;
  // Per-item timestamp. NOTE: only session_lifecycle/state_update/model_switch/
  // compaction_fencepost/system_reminder/classifier_decision/context_cleared history
  // items carry `emitted_at` (per the wire schema). The transcript-rendering kinds
  // (user/assistant/tool_result) do NOT — they carry only HistoryItemMeta
  // (item_id + projected_index). So emitted_at is undefined for those, and we fall
  // back to a monotonic synthetic ISO timestamp (epoch-anchored, advancing per item)
  // so the client's relative-time display gets a valid Date instead of an Invalid
  // Date from "h-N". The absolute value is wrong (epoch), but it's never shown as
  // wall-clock — only as ordering within the replayed transcript, which seq preserves.
  const ts = (item: { emitted_at?: string }, i: number) =>
    item.emitted_at ?? new Date(i * 1000).toISOString();

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as { type?: string; emitted_at?: string } & Record<string, unknown>;
    if (!item || typeof item.type !== "string") continue;

    switch (item.type) {
      case "user": {
        const content = item.content;
        out.push({
          sessionRef: ref,
          timestamp: ts(item, i),
          type: "userMessage",
          id: `u-${seq++}`,
          text: typeof content === "string" ? content : "",
        });
        break;
      }
      case "assistant": {
        const blocks = item.blocks;
        if (!Array.isArray(blocks)) break;
        for (const b of blocks) {
          const block = b as ContentBlock;
          if (!block || typeof block !== "object") continue;
          if (block.type === "text") {
            out.push({
              sessionRef: ref,
              timestamp: ts(item, i),
              type: "assistantDelta",
              text: block.text,
              channel: "text",
            });
          } else if (block.type === "thinking") {
            out.push({
              sessionRef: ref,
              timestamp: ts(item, i),
              type: "assistantDelta",
              text: block.text,
              channel: "thinking",
            });
          } else if (block.type === "tool_use") {
            out.push({
              sessionRef: ref,
              timestamp: ts(item, i),
              type: "toolStarted",
              callId: block.id,
              toolName: block.name,
              input: block.input,
            });
          }
          // redacted_thinking / open_ai_reasoning_opaque: no transcript text (skip).
        }
        break;
      }
      case "tool_result": {
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const lifted = liftToolResult(
          (item.content as ToolResultContent | null | undefined) ?? null,
          item.is_error as boolean | null | undefined,
        );
        out.push({
          sessionRef: ref,
          timestamp: ts(item, i),
          type: "toolFinished",
          callId,
          success: lifted.success,
          output: lifted.output,
          images: lifted.images,
        });
        break;
      }
      // Non-transcript history kinds: skipped on the replay path. The live
      // event-fold handles their ambient effects (state fetches, notifications);
      // replaying them as transcript rows would duplicate or mis-render.
      default:
        break;
    }
  }
  return out;
}
