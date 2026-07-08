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
} from "@pilot/protocol";

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
  /** The body in chronological order: collapsible work runs interleaved with pinned
   *  always-visible items. This is what the transcript renders (the work/visible split
   *  above is kept only for the turn-footer text scan and tests). */
  lanes: TurnLane[];
  /** Whether to offer the collapse affordance: there's real work (≥1 tool) AND a final
   *  response to keep showing once it's hidden. Turns still in flight, or that ended on a
   *  tool / pure narration, render inline instead. */
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
  // non-assistant item) breaks the run, so anything before it stays in `work`.
  let k = body.length;
  while (k > 0 && body[k - 1]!.kind === "assistant") k--;
  // Pull always-visible tools (the answer Q&A, plus any image-bearing tool — a
  // screenshot or rendered mockup) out of the collapsible work so they never hide.
  // `work`/`visible` are flat splits kept for the footer text scan + tests; `lanes`
  // (below) is what actually renders, keeping each pinned item in chronological place.
  // NOTE: the lead-up peel (below) moves assistant paragraphs into pinned lanes too,
  // so `work`/`visible` are recomputed from `lanes` after the loop — not from these
  // initial filters. `collapsible` still reads the pre-peel work set, which is fine:
  // peeling only removes trailing assistant items, so `work.some(isWorkTool)` is stable.
  const workItems = body.slice(0, k);
  const response = body.slice(k);
  const turnHasResponse = response.length > 0;
  const prePeelWork = workItems.filter((i) => !isVisibleTool(i));
  // `TranscriptItem[]` (not the narrower `ToolItem[]` the isVisibleTool guard yields) so the
  // lead-up peel can push assistant paragraphs into `visible` too.
  let work: TranscriptItem[] = prePeelWork;
  let visible: TranscriptItem[] = workItems.filter(isVisibleTool);
  const collapsible = turnHasResponse && work.some(isWorkTool);

  // Lanes preserve chronological order: a contiguous run of non-visible work folds into
  // one collapsible run; each visible tool stays pinned in place between runs, so it
  // doesn't float to the bottom of the work block as later work streams in.
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
      collapsible: turnHasResponse && items.some(isWorkTool),
      startTs: itemStart(items[0]!),
      endTs: itemEnd(items[items.length - 1]!),
    });
  };
  const flushLeadUp = (leadUpItems: TranscriptItem[]) => {
    for (const it of leadUpItems)
      lanes.push({ kind: "pinned", id: it.id, item: it });
  };
  for (const it of workItems) {
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
  // lead-up assistant items land in `visible` too.
  work = [];
  visible = [];
  for (const lane of lanes) {
    if (lane.kind === "work") work.push(...lane.items);
    else visible.push(lane.item);
  }

  // Explicit undefined checks, not `||`: a timestamp can be a numeric string like "0",
  // which is falsy — `||` would wrongly skip it.
  const startTs = user
    ? itemStart(user)
    : work.length > 0
      ? itemStart(work[0]!)
      : undefined;
  let endTs =
    response.length > 0 ? itemEnd(response[response.length - 1]!) : undefined;
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
    lanes,
    collapsible,
    startTs,
    endTs,
  };
}

export function groupTurns(
  items: readonly TranscriptItem[],
  lastTurnActive = false,
): TurnGroup[] {
  const turns: TurnGroup[] = [];
  let user: TranscriptItem | undefined;
  let body: TranscriptItem[] = [];
  let started = false;
  const flush = () => {
    if (!started) return;
    turns.push(buildTurn(user, body, turns.length));
    user = undefined;
    body = [];
  };
  for (const item of items) {
    // A user prompt OR an injected custom message opens a new turn. The inject case is
    // the fix for extension nudges (e.g. journal-nudge): the daemon's sendMessage triggers a
    // fresh run with no user prompt, so without splitting here the new run's tools +
    // reply glue onto the prior turn and collapse its final response into "work".
    if (item.kind === "user" || item.kind === "inject") {
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
  // A trailing assistant paragraph is only a *candidate* final response until the
  // run settles: another tool call can still move it back into `work`. Keep that
  // live turn inline so the collapse affordance cannot flicker in and out between
  // text and tool events.
  if (lastTurnActive) {
    const last = turns[turns.length - 1];
    if (last) {
      last.collapsible = false;
      for (const lane of last.lanes)
        if (lane.kind === "work") lane.collapsible = false;
    }
  }
  return turns;
}

// ── Injected custom-message (nudge) rendering ────────────────────────────────
export function isInjectItem(i: TranscriptItem): i is InjectItem {
  return i.kind === "inject";
}

/** The text to show when an injected note is expanded. Extensions wrap their nudge in
 *  a single XML-ish tag (e.g. `<journal-nudge>…</journal-nudge>`) as an attribution
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
