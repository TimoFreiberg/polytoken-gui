// Pure view-model transforms over the folded transcript. Kept out of the Svelte
// component so the grouping rules are unit-testable in isolation (no DOM, no store).
//
// Two passes, applied in order:
//   1. filterHiddenThinking — drop thinking-only assistant items when the "hide
//      thinking" toggle is on. These render nothing (no text, thinking suppressed),
//      so they'd be invisible gaps between tool cards.
//   2. groupTurns  — split the flat item list into turns (user → next user) and, within
//      each, separate the collapsible "work" (tools + intermediate narration) from the
//      turn-final assistant response that stays visible. This is the Codex-style
//      "Worked for Ns" block: collapsed once the turn settles, the answer left showing.

import type {
  AssistantItem,
  InjectItem,
  ToolItem,
  TranscriptItem,
} from "@pantoken/protocol";

// Tools whose result the USER is meant to read, not the agent's scratch work. They
// render as a visible, in-order block (see TurnGroup.visible) instead of collapsing
// into the "Worked for Ns" work block. `answer` carries the Q&A the user just filled
// in — burying it would hide their own responses.
export const VISIBLE_TOOLS = new Set(["answer"]);

/** A tool that returned image content — a screenshot, a rendered mockup, an image read.
 *  These are visual artifacts the user is meant to SEE, so they get the same treatment as
 *  VISIBLE_TOOLS: never collapsed into the work block, and pulled out into the
 *  always-visible slot so the picture doesn't vanish behind "Worked for Ns".
 *  Detected by the `images` field (populated at toolFinished), not by tool name, so ANY
 *  image-returning tool qualifies — `preview_screenshot`, a render tool, a read of a PNG. */
function toolHasImages(t: ToolItem): boolean {
  return (t.images?.length ?? 0) > 0;
}

function isVisibleTool(i: TranscriptItem): i is ToolItem {
  return i.kind === "tool" && (VISIBLE_TOOLS.has(i.name) || toolHasImages(i));
}

/** Only explicit boundary-marked injects start a new outer turn. */
export function startsTurn(i: TranscriptItem): boolean {
  return i.kind === "user" || (i.kind === "inject" && i.turnBoundary === true);
}

/** Structural marker injects — `context-cleared` and `compaction`. These are
 *  always-visible boundary events, not inline work content. They're pinned as
 *  visible lanes (never folded into a collapsed work run) and skipped by the
 *  trailing-assistant scan so they don't break response detection. */
const STRUCTURAL_MARKER_TYPES = new Set(["context-cleared", "compaction"]);

function isStructuralMarker(i: TranscriptItem): boolean {
  return i.kind === "inject" && STRUCTURAL_MARKER_TYPES.has(i.customType);
}

/** An interrupted tool (status `"interrupted"`). These trail a planning session's
 *  summary after the agent stops — e.g. a `handoff_plan` whose `tool_result` was
 *  lost to a `context_cleared`. Skipped by the trailing-assistant scan and pinned
 *  as a visible lane after the response. */
function isInterruptedTool(i: TranscriptItem): boolean {
  return i.kind === "tool" && i.status === "interrupted";
}

/** A blocking Q&A prompt: the `answer` tool. Scoped to `answer` only — image-bearing
 *  tools are pinned too, but they're not prompts, so their lead-up narration doesn't
 *  get the keep-visible treatment (see keepLeadUp below). HostUi dialogs (confirm/
 *  input/select/qna) don't flow through tools at all, so they're out of scope here. */
function isAnswerTool(i: TranscriptItem): i is ToolItem {
  return i.kind === "tool" && i.name === "answer";
}

/** The lead-up paragraph(s) the agent wrote immediately before asking via the `answer`
 *  tool — the trailing assistant items of the work run that precedes a pinned answer
 *  card. These carry the question's context, so they must stay visible directly above
 *  the Q&A card and the user's answer instead of folding into "Worked for Ns". Returns
 *  the split: [collapsibleWork, visibleLeadUp]. */
function splitLeadUp(run: TranscriptItem[]): [TranscriptItem[], TranscriptItem[]] {
  let j = run.length;
  while (j > 0 && run[j - 1]!.kind === "assistant") j--;
  return [run.slice(0, j), run.slice(j)];
}

/** A settled assistant response (one carrying `completedAt`) trailed by a
 *  non-assistant item must stay visible instead of collapsing into "Worked for
 *  Ns". This is the late-notification invariant: a delayed background-agent
 *  notification folds into a `notice` transcript item, which lands *after* an
 *  already-settled final response inside the same turn. The notice breaks the
 *  trailing-assistant-run scan in `buildTurn`, so without promotion that settled
 *  response would fold into `work` and hide behind the collapse header — leaving
 *  only the short follow-up visible. Promoting the settled response AND the
 *  trailing notice(s) into pinned lanes keeps both visible in place.
 *
 *  A preserved segment starts at a `completedAt`-stamped assistant item that is
 *  followed (within `workItems`) by a `notice`, and extends to include every
 *  immediately-following `notice` up to the next settled assistant or the end of
 *  `workItems`. Returns the inclusive `[start, end]` index ranges.
 *
 *  Only `notice` items trigger promotion — never `inject`. Extension injects
 *  (extension nudges, system reminders) are designed to fold INTO the collapsed work
 *  block (rendering as an `.inject-pill` inside it), so promoting them out would
 *  wrongly split a single work run into two. A notice, by contrast, is a passive
 *  cross-session event (a late background-agent notification) that should stay
 *  visible in place rather than hide behind a collapse header.
 *
 *  Key non-regression: when the `completedAt` assistant is the genuine trailing
 *  run (the greeting/cold-restore case — not trailed by a notice), no segment is
 *  produced, so behavior is unchanged. The promotion is also keyed on
 *  `completedAt` *presence*, not its value, so cold-restored turns (whose
 *  `completedAt` sits far past `ts`) still collapse correctly when no notice
 *  follows. A non-settled streaming assistant (no `completedAt`) interrupted by a
 *  compaction notice is NOT promoted — it keeps folding into work as before. */
export function findPreservedSegments(
  workItems: readonly TranscriptItem[],
): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  for (let i = 0; i < workItems.length; i++) {
    const it = workItems[i]!;
    // A preserved segment starts at a settled assistant response.
    if (!(it.kind === "assistant" && it.completedAt !== undefined)) continue;
    // …that is trailed by a `notice` — the late-notification case. Only a notice
    // (a passive cross-session event) triggers promotion; an `inject` (extension
    // nudge like extension-nudge) does NOT — it folds into the work block as an
    // `.inject-pill`. If this is the last item, or the next item is an assistant
    // (the normal trailing run), a tool (new work), or an inject (folds into work),
    // it's not preserved. Tools/injects are never part of a preserved segment: the
    // former keeps turn-level `collapsible` stable (keys on the pre-peel work tool
    // count), the latter must stay inside the collapsed work block.
    const next = workItems[i + 1];
    if (i + 1 >= workItems.length || next!.kind !== "notice") continue;
    // Extend the segment over the settled response + every immediately-following
    // notice (multiple late notifications can stack). Stops at any assistant, tool,
    // or inject — those stay in the work run.
    let end = i;
    while (
      end + 1 < workItems.length &&
      workItems[end + 1]!.kind === "notice"
    )
      end++;
    segments.push([i, end]);
    // Continue scanning AFTER this segment (don't skip — a later settled response
    // trailed by another notice must be found too, per the multi-notification case).
    i = end;
  }
  return segments;
}

/** The id of the assistant item that is the active thinking tail: the LAST
 *  item, only if it is an assistant item still accumulating reasoning with no
 *  answer text yet (thinking present, text empty). This is the single thinking
 *  block shown (collapsed) when hideThinking is on — the moment any text or
 *  tool follows, it is superseded and dropped. Returns undefined when no such
 *  tail exists. */
export function thinkingTailId(
  items: readonly TranscriptItem[],
): string | undefined {
  const last = items[items.length - 1];
  if (
    last &&
    last.kind === "assistant" &&
    (last as AssistantItem).thinking !== "" &&
    last.text.trim() === ""
  ) {
    return last.id;
  }
  return undefined;
}

/** Filter out superseded thinking-only items when thinking is hidden. When the
 *  "hide thinking" toggle is on, every thinking-only assistant item (no text)
 *  is dropped EXCEPT the active thinking tail — the last item, if it is still
 *  streaming reasoning with no answer text yet. Once any text or tool follows,
 *  the thinking is superseded and dropped entirely (no collapsed stub lingers).
 *  Items with both thinking + text are never dropped (text is always visible,
 *  though their thinking block won't render — see thinkingTailId). When
 *  thinking is visible, the pass is a no-op (returns a shallow copy). */
export function filterHiddenThinking(
  items: readonly TranscriptItem[],
  hideThinking: boolean,
): TranscriptItem[] {
  if (!hideThinking) return [...items];
  const tail = thinkingTailId(items);
  return items.filter((i) => {
    // Keep non-thinking-only items: tools, user items, and assistant items
    // with text (text is always visible). A thinking-only assistant item
    // survives ONLY if it's the active tail.
    if (
      i.kind === "assistant" &&
      i.text.trim() === "" &&
      (i as AssistantItem).thinking !== ""
    ) {
      return i.id === tail;
    }
    return true;
  });
}

/** True for tool items — the "work" that the turn-level collapse treats as activity. */
export function isWorkTool(i: TranscriptItem): boolean {
  return i.kind === "tool";
}

// ── Pass 2: group into turns and split work vs. response ─────────────────────

/** One chronological slice of a turn's body. Either a contiguous run of collapsible
 *  work (tools + narration) that folds behind its own "Worked for Ns" header, or a
 *  single always-visible item (the answer Q&A / a screenshot) pinned in place so it
 *  never floats below later work as the turn streams in. */
export interface WorkLane {
  kind: "work";
  /** Stable key per work run within a turn (`${turnId}:w${runIndex}`). */
  id: string;
  items: TranscriptItem[];
  /** Offer the collapse affordance for THIS run: it holds a work tool and the turn has
   *  a trailing response to keep showing once collapsed. Forced false while the turn is
   *  still in flight (see groupTurns' lastTurnActive). */
  collapsible: boolean;
  startTs?: string;
  endTs?: string;
}
export interface PinnedLane {
  kind: "pinned";
  /** The pinned item's own id. */
  id: string;
  item: TranscriptItem;
}
export type TurnLane = WorkLane | PinnedLane;

export interface TurnGroup {
  /** Stable key for the turn (the user item's id, else the first item's, else index). */
  id: string;
  /** The item that opened the turn, if any: a user prompt, or an injected custom
   *  message (a nudge) that triggered a fresh run. A leading run before the first such
   *  item — e.g. a snapshot mid-turn — yields a turn with no head. */
  user?: TranscriptItem;
  /** The collapsible portion: tools, thinking, and intermediate narration. */
  work: TranscriptItem[];
  /** Always-visible items pulled out of `work` — the `answer` tool's Q&A result (see
   *  VISIBLE_TOOLS) and any image-bearing tool (see toolHasImages: a screenshot, a
   *  rendered mockup). Rendered between the collapsed work block and the final response
   *  so the user's own answers — and the pictures the agent surfaced — don't hide. */
  visible: TranscriptItem[];
  /** The turn-final assistant message(s) — the trailing run of assistant items after the
   *  last tool. Rendered visibly; the work collapses behind the "Worked for Ns" header. */
  response: TranscriptItem[];
  /** Trailing non-response items pinned after the response: structural markers
   *  (context-cleared, compaction) and interrupted tools that were skipped by the
   *  trailing assistant scan. Rendered after the response in chronological order, so
   *  the visual order is `[work block] [response summary] [interrupted tool card] [context-cleared pill]`. */
  postResponse: TranscriptItem[];
  /** The body in chronological order: collapsible work runs interleaved with pinned
   *  always-visible items. This is what the transcript renders (the work/visible split
   *  above is kept only for the turn-footer text scan and tests). */
  lanes: TurnLane[];
  /** Whether to offer the collapse affordance: there's real work (≥2 tools) AND a final
   *  response to keep showing once it's hidden. A single-tool turn renders inline
   *  (collapsed ToolCard, click to expand — no "Worked for Ns" header). Turns still in
   *  flight, or that ended on a tool / pure narration, render inline instead. */
  collapsible: boolean;
  /** Turn start — the user item's timestamp (falls back to the first work item's). */
  startTs?: string;
  /** Turn end — the response's `completedAt` (falls back to its `ts`, then last work). */
  endTs?: string;
}

function itemStart(i: TranscriptItem): string | undefined {
  if (i.kind === "tool") return i.startedAt ?? i.finishedAt;
  if (i.kind === "user" || i.kind === "assistant" || i.kind === "inject")
    return i.ts;
  return undefined;
}
function itemEnd(i: TranscriptItem): string | undefined {
  if (i.kind === "assistant") return i.completedAt ?? i.ts;
  if (i.kind === "tool") return i.finishedAt ?? i.startedAt;
  if (i.kind === "user" || i.kind === "inject") return i.ts;
  return undefined;
}

function buildTurn(
  user: TranscriptItem | undefined,
  body: TranscriptItem[],
  index: number,
): TurnGroup {
  // The response is the maximal trailing run of assistant items at the very end of the
  // body — i.e. the last full assistant message(s) after the last tool. A tool (or any
  // non-assistant item) breaks the run — EXCEPT structural markers (context-cleared,
  // compaction injects) and interrupted tools that trail the response. These are pinned
  // as visible lanes AFTER the response (in `postResponse`), so they don't break the
  // scan. This handles a planning session that ends with:
  //   [..., assistant(summary), tool(handoff_plan, interrupted), inject(context-cleared)]
  // The scan skips the inject + interrupted tool, finds the assistant behind them, and
  // collects the skipped items into `postResponse`.
  let k = body.length;
  const trailingPinned: TranscriptItem[] = [];
  // Phase 1: skip structural markers, interrupted tools, and notices trailing the last
  // assistant. These are collected into `postResponse` (pinned visible lanes after the
  // response). Notices that trail a settled response are normally handled by the
  // preserved-segment machinery — but here the response is the trailing assistant run
  // (already visible), so the preserved-segment pairing is unnecessary. The notice renders
  // as a pinned lane in `postResponse` instead.
  while (k > 0 && body[k - 1]!.kind !== "assistant") {
    const prev = body[k - 1]!;
    if (isStructuralMarker(prev) || isInterruptedTool(prev) || prev.kind === "notice") {
      trailingPinned.unshift(prev);
      k--;
      continue;
    }
    break;
  }
  // Phase 2: scan backward through the trailing assistant run (the response).
  while (k > 0 && body[k - 1]!.kind === "assistant") k--;
  // Edge case: the body ends with [notice, interrupted tool, inject(context-cleared)] and
  // there is NO assistant before them. The scan skipped all trailing items but found no
  // response. In that case, undo: put everything back into workItems (response=[],
  // postResponse=[]).
  if (body[k]?.kind !== "assistant") {
    k = body.length;
    trailingPinned.length = 0;
  }
  const workItems = body.slice(0, k);
  const response = body.slice(k, body.length - trailingPinned.length);
  const postResponse = trailingPinned;
  const turnHasResponse = response.length > 0;
  const prePeelWork = workItems.filter((i) => !isVisibleTool(i));
  // `TranscriptItem[]` (not the narrower `ToolItem[]` the isVisibleTool guard yields) so the
  // lead-up peel can push assistant paragraphs into `visible` too.
  let work: TranscriptItem[] = prePeelWork;
  let visible: TranscriptItem[] = workItems.filter(isVisibleTool);
  // ≥2 work tools are required to offer the collapse affordance. A single-tool turn
  // renders inline (collapsed ToolCard, click to expand — no "Worked for Ns" header).
  const workToolCount = work.filter(isWorkTool).length;
  const collapsible = turnHasResponse && workToolCount >= 2;

  // Lanes preserve chronological order: a contiguous run of non-visible work folds into
  // one collapsible run; each visible tool stays pinned in place between runs, so it
  // doesn't float to the bottom of the work block as later work streams in. Non-boundary
  // injects (system reminders, extension nudges, …) fold into the current work run as
  // inline content rather than being pinned as separate lanes, so a turn with
  // `edit_plan` → reminder → `edit_plan` → reminder produces one contiguous "Worked for
  // Ns" block, not one per tool call. The inject pill still renders (when
  // `display:true`) — just inside the collapsed work block. `turnBoundary:true` injects
  // (goal reminders) never reach here: they start a new turn via `startsTurn`.
  // EXCEPTION: structural markers (context-cleared, compaction) are pinned as visible
  // lanes, never folded into work — they're always-visible boundary events.
  //
  // Lead-up keep-visible: when a work run is immediately followed by a pinned `answer`
  // card, peel its trailing assistant paragraph(s) into pinned lanes too. Those carry
  // the question's context — they belong directly above the Q&A + the user's answer, not
  // hidden inside the collapsed "Worked for Ns" run. Scoped to `answer` only.
  const turnId = user?.id ?? body[0]?.id ?? `turn-${index}`;
  const lanes: TurnLane[] = [];
  let run: TranscriptItem[] = [];
  let runIndex = 0;
  const flushRun = () => {
    if (run.length === 0) return;
    const items = run;
    run = [];
    lanes.push({
      kind: "work",
      id: `${turnId}:w${runIndex++}`,
      items,
      collapsible: turnHasResponse && items.filter(isWorkTool).length >= 2,
      startTs: itemStart(items[0]!),
      endTs: itemEnd(items[items.length - 1]!),
    });
  };
  const flushLeadUp = (leadUpItems: TranscriptItem[]) => {
    for (const it of leadUpItems)
      lanes.push({ kind: "pinned", id: it.id, item: it });
  };
  // Preserved segments: settled responses trailed by notices (see
  // findPreservedSegments). Each item in a segment becomes its own pinned lane so
  // both the settled response AND the trailing notice(s) render visibly in place —
  // neither collapses behind "Worked for Ns". Built once as an index→segment map so
  // the main loop can check membership in O(1) without re-scanning.
  const preserved = findPreservedSegments(workItems);
  const preservedAt = new Map<number, [number, number]>();
  for (const seg of preserved) {
    for (let s = seg[0]; s <= seg[1]; s++) preservedAt.set(s, seg);
  }
  for (let idx = 0; idx < workItems.length; idx++) {
    const it = workItems[idx]!;
    // A preserved segment is flushed as one-per-item pinned lanes (settled
    // response + trailing notices), skipping past the whole segment.
    const seg = preservedAt.get(idx);
    if (seg) {
      flushRun();
      for (let s = seg[0]; s <= seg[1]; s++)
        lanes.push({ kind: "pinned", id: workItems[s]!.id, item: workItems[s]! });
      idx = seg[1];
      continue;
    }
    // Structural markers (context-cleared, compaction) are pinned as visible lanes,
    // never folded into a collapsed work run.
    if (isStructuralMarker(it)) {
      flushRun();
      lanes.push({ kind: "pinned", id: it.id, item: it });
      continue;
    }
    if (isVisibleTool(it)) {
      // Peel the lead-up paragraph(s) off the run BEFORE pinning the answer card, so
      // they render between the (now shorter) collapsible work run and the Q&A.
      if (isAnswerTool(it) && run.length > 0) {
        const [work, leadUp] = splitLeadUp(run);
        run = work;
        flushRun();
        flushLeadUp(leadUp);
      } else {
        flushRun();
      }
      lanes.push({ kind: "pinned", id: it.id, item: it });
    } else {
      run.push(it);
    }
  }
  flushRun();

  // Recompute the flat `work`/`visible` splits FROM the lanes so they reflect the
  // lead-up peel: assistant paragraphs moved into pinned lanes are visible, not work.
  // Keeps the footer text scan (turnText in Transcript.svelte) + tests in sync with
  // what actually renders. Pinned answer/image tools land in `visible`; pinned
  // lead-up assistant items land in `visible` too. `postResponse` items are all
  // pinned/visible by definition, so they're added to `visible` as well.
  work = [];
  visible = [];
  for (const lane of lanes) {
    if (lane.kind === "work") work.push(...lane.items);
    else visible.push(lane.item);
  }
  visible.push(...postResponse);

  // Explicit undefined checks, not `||`: a timestamp can be a numeric string like "0",
  // which is falsy — `||` would wrongly skip it.
  const startTs = user
    ? itemStart(user)
    : work.length > 0
      ? itemStart(work[0]!)
      : undefined;
  let endTs =
    response.length > 0 ? itemEnd(response[response.length - 1]!) : undefined;
  // When trailing pinned items (interrupted tools, context-cleared injects) follow
  // the response, the turn's end is the last trailing item's timestamp — not the
  // response's. This ensures the "Worked for Ns" duration reads the full turn span.
  if (postResponse.length > 0) {
    const trailingEnd = itemEnd(postResponse[postResponse.length - 1]!);
    if (trailingEnd !== undefined) endTs = trailingEnd;
  }
  if (endTs === undefined && work.length > 0)
    endTs = itemEnd(work[work.length - 1]!);

  // Anchor the outer work runs to the turn's own bounds: the first run starts when the
  // turn started (the user prompt, before any work item), the last ends when the final
  // response settled. So a single-work-run turn's "Worked for Ns" still reads the whole
  // turn duration; only inner runs (split by a pinned card) measure their own span.
  const workLanes = lanes.filter((l): l is WorkLane => l.kind === "work");
  const firstWork = workLanes[0];
  const lastWork = workLanes[workLanes.length - 1];
  if (firstWork && startTs !== undefined) firstWork.startTs = startTs;
  if (lastWork && endTs !== undefined) lastWork.endTs = endTs;

  return {
    id: turnId,
    user,
    work,
    visible,
    response,
    postResponse,
    lanes,
    collapsible,
    startTs,
    endTs,
  };
}

interface TurnInput {
  user: TranscriptItem | undefined;
  body: TranscriptItem[];
}

function collectTurnInputs(items: readonly TranscriptItem[]): TurnInput[] {
  const inputs: TurnInput[] = [];
  let user: TranscriptItem | undefined;
  let body: TranscriptItem[] = [];
  let started = false;
  const flush = () => {
    if (!started) return;
    inputs.push({ user, body });
    user = undefined;
    body = [];
  };
  for (const item of items) {
    // User prompts and explicit boundary-marked injects open a new outer turn.
    // Ordinary injects remain chronological content inside the current turn.
    if (startsTurn(item)) {
      flush();
      user = item;
      body = [];
      started = true;
    } else {
      started = true;
      body.push(item);
    }
  }
  flush();
  return inputs;
}

function inactiveLastTurn(turn: TurnGroup): TurnGroup {
  return {
    ...turn,
    collapsible: false,
    lanes: turn.lanes.map((lane) =>
      lane.kind === "work" ? { ...lane, collapsible: false } : lane,
    ),
  };
}

function applyLastTurnActive(
  turns: TurnGroup[],
  lastTurnActive: boolean,
): TurnGroup[] {
  if (!lastTurnActive || turns.length === 0) return turns;
  const lastIndex = turns.length - 1;
  return turns.map((turn, index) =>
    index === lastIndex ? inactiveLastTurn(turn) : turn,
  );
}

export function groupTurns(
  items: readonly TranscriptItem[],
  lastTurnActive = false,
): TurnGroup[] {
  const turns = collectTurnInputs(items).map((input, index) =>
    buildTurn(input.user, input.body, index),
  );
  // A trailing assistant paragraph is only a *candidate* final response until the
  // run settles: another tool call can still move it back into `work`. Keep that
  // live turn inline so the collapse affordance cannot flicker in and out between
  // text and tool events.
  return applyLastTurnActive(turns, lastTurnActive);
}

type CachedTurn = {
  fingerprint: string;
  turn: TurnGroup;
};

const objectFingerprintIds = new WeakMap<object, number>();
let nextObjectFingerprintId = 1;

function outputFingerprint(output: unknown): string {
  if (output === undefined) return "";
  if (output === null) return "null";
  if (typeof output === "object") {
    let id = objectFingerprintIds.get(output);
    if (id === undefined) {
      id = nextObjectFingerprintId++;
      objectFingerprintIds.set(output, id);
    }
    return `o:${id}`;
  }
  if (typeof output === "string") return `s:${output.length}`;
  return `${typeof output}:${String(output)}`;
}

function itemFingerprint(item: TranscriptItem): string {
  switch (item.kind) {
    case "assistant":
      return [
        item.kind,
        item.id,
        item.ts ?? "",
        item.completedAt ?? "",
        item.entryId ?? "",
        item.streaming ? "1" : "0",
        item.text.length,
        item.thinking.length,
      ].join("\u001f");
    case "tool":
      return [
        item.kind,
        item.id,
        item.name,
        item.status,
        item.startedAt ?? "",
        item.finishedAt ?? "",
        item.images?.length ?? 0,
        item.text?.length ?? 0,
        item.progress ?? "",
        outputFingerprint(item.output),
      ].join("\u001f");
    case "user":
      return [
        item.kind,
        item.id,
        item.ts ?? "",
        item.entryId ?? "",
        item.delivery ?? "",
        item.deliveryError ?? "",
        item.text.length,
        item.images?.length ?? 0,
      ].join("\u001f");
    case "inject":
      return [
        item.kind,
        item.id,
        item.ts ?? "",
        item.customType,
        item.display ? "1" : "0",
        item.turnBoundary ? "1" : "0",
        item.text.length,
      ].join("\u001f");
    case "notice":
      return [item.kind, item.id, item.level, item.text].join("\u001f");
  }
}

function turnFingerprint(input: TurnInput): string {
  const items = input.user ? [input.user, ...input.body] : input.body;
  return items.map(itemFingerprint).join("\u001e");
}

/** Create an instance-local turn grouper that reuses already-built turn view models.
 *  Transcript events usually mutate or append at the active tail while old item objects
 *  stay stable, so caching by turn id + render-relevant item fingerprint avoids rebuilding
 *  every settled turn on each transcript invalidation. */
export function createTurnGrouper(): typeof groupTurns {
  let cache = new Map<string, CachedTurn>();
  return (items, lastTurnActive = false) => {
    const nextCache = new Map<string, CachedTurn>();
    const turns = collectTurnInputs(items).map((input, index) => {
      const id = input.user?.id ?? input.body[0]?.id ?? `turn-${index}`;
      const fingerprint = turnFingerprint(input);
      const cached = cache.get(id);
      if (cached?.fingerprint === fingerprint) {
        nextCache.set(id, cached);
        return cached.turn;
      }
      const turn = buildTurn(input.user, input.body, index);
      nextCache.set(id, { fingerprint, turn });
      return turn;
    });
    cache = nextCache;
    return applyLastTurnActive(turns, lastTurnActive);
  };
}

// ── Injected custom-message (nudge) rendering ────────────────────────────────
export function isInjectItem(i: TranscriptItem): i is InjectItem {
  return i.kind === "inject";
}

/** The text to show when an injected note is expanded. Extensions wrap their nudge in
 *  a single XML-ish tag (e.g. `<extension-nudge>…</extension-nudge>`) as an attribution
 *  signal; strip one matching outer tag so the body reads clean. Falls back to the raw
 *  text when there's no wrapper. */
export function injectText(item: InjectItem): string {
  const m = item.text.match(/^\s*<([\w-]+)>([\s\S]*)<\/\1>\s*$/);
  return (m?.[2] ?? item.text).trim();
}

// ── Duration formatting for the "Worked for Ns" header ───────────────────────

/** Parse a timestamp that's either epoch-ms (the mock's numeric counter) or an ISO
 *  string. Null when unparseable. Mirrors ToolCard's badge parser. */
export function parseTs(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  const ms = Number.isNaN(n) ? Date.parse(s) : n;
  return Number.isNaN(ms) ? null : ms;
}

/** Whole-second granularity, Codex-style: "Worked for 37s", "2m 5s", "1h 3m". Sub-second
 *  rounds up to "1s" so a real (if brief) turn never reads "0s". */
export function formatWorkedDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** The label for a work-run header. Null duration (missing/!bad timestamps) → just
 *  "Worked"; a settled run with both bounds → "Worked for Ns". Takes anything with
 *  start/end bounds — a whole turn or a single work lane. */
export function workedLabel(span: {
  startTs?: string;
  endTs?: string;
}): string {
  const a = parseTs(span.startTs);
  const b = parseTs(span.endTs);
  if (a === null || b === null || b < a) return "Worked";
  return `Worked for ${formatWorkedDuration(b - a)}`;
}

// ── Answer (Q&A) result rendering ────────────────────────────────────────────

/** Extract plain text from a tool's `output`. Live results arrive as the daemon's raw
 *  object `{ content: [{ type:"text", text }], details? }`; replayed-from-history
 *  results are already plain strings. Mirrors ToolCard.outputText so the answer
 *  block reads the same before and after a reload. */
export function toolOutputText(out: unknown): string {
  if (typeof out === "string") return out;
  if (out && typeof out === "object") {
    const content = (out as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((b) =>
          b &&
          typeof b === "object" &&
          typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
        )
        .join("");
      if (text) return text;
    }
  }
  return "";
}

/** One question's record parsed back out of the answer tool's transcript text. */
export interface QnaResultEntry {
  question: string;
  context?: string;
  /** Present for choice questions; each option with whether it was picked. */
  options?: { label: string; picked: boolean }[];
  /** The human-readable answer line (picked labels and/or typed text). */
  answer: string;
}

/**
 * Parse the answer extension's `formatQnA` output back into structured entries so
 * the transcript can render the Q&A cleanly instead of dumping raw text. The format
 * (produced out-of-repo by agents/extensions/answer.ts) is:
 *
 *   Q: <question>
 *   > <context>           (optional)
 *   Options:              (optional, choice questions)
 *     [x] <label>
 *     [ ] <label>
 *   A: <answer>
 *
 * Tolerant by design — returns null when nothing parses (no `Q:` lines) so callers
 * fall back to showing the raw text rather than an empty block. If the upstream
 * format drifts, the fallback keeps the answers visible.
 */
export function parseQnaResult(text: string): QnaResultEntry[] | null {
  const entries: QnaResultEntry[] = [];
  let cur: QnaResultEntry | null = null;
  let inOptions = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("Q: ")) {
      if (cur) entries.push(cur);
      cur = { question: line.slice(3).trim(), answer: "" };
      inOptions = false;
    } else if (!cur) {
      continue;
    } else if (line.startsWith("> ")) {
      cur.context = line.slice(2).trim();
    } else if (line.trim() === "Options:") {
      inOptions = true;
      cur.options = [];
    } else if (inOptions && /^\s*\[[ xX]\]\s/.test(line)) {
      const picked = /\[[xX]\]/.test(line);
      const label = line.replace(/^\s*\[[ xX]\]\s+/, "").trim();
      (cur.options ??= []).push({ label, picked });
    } else if (line.startsWith("A: ")) {
      cur.answer = line.slice(3).trim();
      inOptions = false;
    }
  }
  if (cur) entries.push(cur);
  return entries.length > 0 ? entries : null;
}
