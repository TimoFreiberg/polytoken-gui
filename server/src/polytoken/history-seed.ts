// Folding polytoken's `GET /history` items into pilot's `SessionDriverEvent[]` —
// the REPLAY/seed path (the inverse of event-map.ts's live stream fold).
//
// `openSession`/`reloadSession` spawn a daemon and must deliver the session's
// existing transcript to the hub atomically: a `sessionOpened` snapshot + the
// replayed history, so the client renders the full conversation on focus/reload
// (the hub resets + folds these, never via `subscribe`).
//
// polytoken's history is a linear event log (no branch DAG), and
// `KnownSessionHistoryItem` is a tagged union on `type`. The renderable kinds for
// a transcript are: `user` (content + prompt_id), `assistant` (blocks[] +
// prompt_id), and `tool_result` (call_id + content + is_error + prompt_id).
// Others (session_lifecycle, model_switch, state_update, facet_switch,
// compaction_fencepost, system_reminder, classifier_decision, context_cleared,
// image_reference) are metadata, not transcript rows — they're skipped on the
// replay path exactly as the live event-fold skips or handles them ambiently.
//
// This mirrors the original driver's historyToEvents: a pure function over a typed input, so it's
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
import { defaultModelRef } from "./models.js";
import { PLAN_REVIEW_LABELS } from "./event-map.js";

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
  // Per-item timestamp. As of daemon 0.4.0-unstable.6+, ALL 12 history kinds carry
  // `emitted_at` on the wire — but with a required/optional split (confirmed against
  // the .7 OpenAPI dump, KnownSessionHistoryItem):
  //   * REQUIRED (always present): session_lifecycle, state_update, model_switch,
  //     compaction_fencepost, system_reminder, classifier_decision, context_cleared,
  //     image_reference.
  //   * OPTIONAL (nullable): user, assistant, tool_result, facet_switch — these gained
  //     `emitted_at` in unstable.6 but the schema marks it optional, so a session
  //     recorded before .6 (or any item the daemon leaves unstamped) can still arrive
  //     without it.
  // We always prefer the real `emitted_at`; the synthetic fallback only fires for an
  // optional-kind item that genuinely lacks one (pre-.6 replay). It is a deterministic
  // monotonic ISO stamp (epoch-anchored, advancing per item) so the client's
  // relative-time display gets a valid Date instead of an Invalid Date. The absolute
  // value is wrong (epoch), but it's never shown as wall-clock — only as ordering
  // within the replayed transcript, which seq preserves. Do NOT delete the fallback:
  // the 4 optional kinds keep it reachable.
  const ts = (item: { emitted_at?: string }, i: number) =>
    item.emitted_at ?? new Date(i * 1000).toISOString();

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as { type?: string; emitted_at?: string } & Record<string, unknown>;
    if (!item || typeof item.type !== "string") continue;

    switch (item.type) {
      case "user": {
        const content = item.content;
        const promptId =
          typeof item.prompt_id === "string" ? item.prompt_id : undefined;
        out.push({
          sessionRef: ref,
          timestamp: ts(item, i),
          type: "userMessage",
          // The daemon's prompt_id IS the branch handle (POST /rewind's
          // to_prompt_id). Thread it as both id (for client reconciliation) and
          // entryId (the branch button's target). Falls back to a synthetic id
          // only for malformed items lacking one (defensive — the wire schema
          // guarantees prompt_id on `user` items).
          id: promptId ?? `u-${seq++}`,
          text: typeof content === "string" ? content : "",
          ...(promptId ? { entryId: promptId } : {}),
        });
        break;
      }
      case "assistant": {
        const blocks = item.blocks;
        if (!Array.isArray(blocks)) break;
        // The assistant message's prompt_id: same per-turn id as the preceding
        // `user` item (the daemon assigns one prompt_id per user turn, and the
        // assistant reply carries it). Thread it as the branch handle for
        // "branch from here" on the assistant turn.
        const promptId =
          typeof item.prompt_id === "string" ? item.prompt_id : undefined;
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
              ...(promptId ? { entryId: promptId } : {}),
            });
          } else if (block.type === "thinking") {
            out.push({
              sessionRef: ref,
              timestamp: ts(item, i),
              type: "assistantDelta",
              text: block.text,
              channel: "thinking",
              ...(promptId ? { entryId: promptId } : {}),
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
      // Non-transcript history kinds: mapped to the same driver events the live
      // path emits, so a reloaded transcript matches what a live session would show.
      case "system_reminder": {
        const reasonType = (
          item.reason as { type?: string } | undefined
        )?.type;
        const label = reasonType
          ? PLAN_REVIEW_LABELS[reasonType]
          : undefined;
        const visible = label !== undefined;
        const slug = typeof item.slug === "string" ? item.slug : "reminder";
        out.push({
          sessionRef: ref,
          timestamp: ts(item, i),
          type: "customMessage",
          id: `reminder-${slug}-${i}`,
          customType: visible ? label : slug,
          text: typeof item.body === "string" ? item.body : "",
          display: visible,
        });
        break;
      }
      case "model_switch": {
        // Thread the model config like the live model_switch event does.
        const toModel = typeof item.to_model === "string" ? item.to_model : undefined;
        if (toModel) {
          const config = {
            ...defaultModelRef(toModel),
            thinkingLevel:
              (item.to_reasoning_effort as string | null | undefined) ??
              undefined,
          };
          out.push({
            sessionRef: ref,
            timestamp: ts(item, i),
            type: "sessionUpdated",
            snapshot: {
              ref,
              workspace: { workspaceId: ref.workspaceId, path: "" },
              title: "",
              status: "idle",
              updatedAt: ts(item, i),
              config,
            },
          });
        }
        break;
      }
      case "facet_switch": {
        const toFacet = typeof item.to_facet === "string" ? item.to_facet : undefined;
        if (toFacet) {
          out.push({
            sessionRef: ref,
            timestamp: ts(item, i),
            type: "sessionUpdated",
            snapshot: {
              ref,
              workspace: { workspaceId: ref.workspaceId, path: "" },
              title: "",
              status: "idle",
              updatedAt: ts(item, i),
              facet: toFacet,
            },
          });
        }
        break;
      }
      case "compaction_fencepost": {
        out.push({
          sessionRef: ref,
          timestamp: ts(item, i),
          type: "customMessage",
          id: `compaction-${item.compaction_id ?? seq}-${i}`,
          customType: "compaction",
          text: typeof item.summary === "string" ? item.summary : "Context compacted",
          display: true,
        });
        break;
      }
      case "context_cleared": {
        out.push({
          sessionRef: ref,
          timestamp: ts(item, i),
          type: "customMessage",
          id: `context-cleared-${i}`,
          customType: "context-cleared",
          text: "Context cleared",
          display: true,
        });
        break;
      }
      case "session_lifecycle": {
        // A lifecycle event (session started/ended etc). Surface as a non-display
        // turn-boundary marker (same as the live path's customMessage with
        // display:false — it splits the turn without rendering a visible row).
        out.push({
          sessionRef: ref,
          timestamp: ts(item, i),
          type: "customMessage",
          id: `lifecycle-${i}`,
          customType: "lifecycle",
          text: typeof item.text === "string" ? item.text : "",
          display: false,
        });
        break;
      }
      // state_update, classifier_decision, image_reference: no transcript
      // representation in the live path either — skip (they're metadata-only).
      default:
        break;
    }
  }
  return out;
}
