// Pure view-model transforms over the folded transcript. Kept out of the Svelte
// component so the grouping rules are unit-testable in isolation (no DOM, no store).
//
// Two passes, applied in order:
//   1. mergeTools  — collapse uninterrupted runs of tools into one summary card,
//      except for write/edit calls, which stay standalone for immediate visibility.
//   2. groupTurns  — split the flat item list into turns (user → next user) and, within
//      each, separate the collapsible "work" (tools + intermediate narration) from the
//      turn-final assistant response that stays visible. This is the Codex-style
//      "Worked for Ns" block: collapsed once the turn settles, the answer left showing.

import type { AssistantItem, ToolItem, TranscriptItem } from "@pilot/protocol";

// ── Pass 1: summarize sequential tools ───────────────────────────────────────
// Every uninterrupted run of tools collapses into ONE summary card, including a
// one-tool run. Write/edit are the only exceptions: their side effects and diffs
// should stay visible as standalone cards, and each one breaks the surrounding run.
export const STANDALONE_TOOLS = new Set(["write", "edit"]);

export interface MergedToolsItem {
  readonly kind: "mergedTools";
  id: string;
  /** Distinct tool names in the run, in first-appearance order. */
  names: string[];
  tools: ToolItem[];
}

/** A transcript item after the merge pass — either an original item or a merged run. */
export type DisplayItem = TranscriptItem | MergedToolsItem;

function isToolItem(i: TranscriptItem): i is ToolItem {
  return i.kind === "tool";
}
function isSummarizedTool(i: TranscriptItem): i is ToolItem {
  return isToolItem(i) && !STANDALONE_TOOLS.has(i.name);
}

/** True for the two "work" item kinds the collapse treats as activity: tool cards and
 *  merged tool runs. (Used by both the merge boundary and the turn split.) */
export function isWorkTool(i: DisplayItem): boolean {
  return i.kind === "tool" || i.kind === "mergedTools";
}

export function mergeTools(items: readonly TranscriptItem[]): DisplayItem[] {
  const result: DisplayItem[] = [];
  let pending: ToolItem[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const first = pending[0]!;
    result.push({
      kind: "mergedTools",
      id: first.id,
      names: [...new Set(pending.map((t) => t.name))],
      tools: pending,
    });
    pending = [];
  };
  for (const item of items) {
    if (isSummarizedTool(item)) {
      pending.push(item);
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}

/** Header summary for a merged card: total count + the distinct names once each,
 *  e.g. "5 tools (read, grep)". */
export function mergedSummary(item: MergedToolsItem): string {
  const noun = item.tools.length === 1 ? "tool" : "tools";
  return `${item.tools.length} ${noun} (${item.names.join(", ")})`;
}

// ── Pass 2: group into turns and split work vs. response ─────────────────────

export interface TurnGroup {
  /** Stable key for the turn (the user item's id, else the first item's, else index). */
  id: string;
  /** The user prompt that opened the turn, if this turn has one (a leading run before
   *  the first user message — e.g. a snapshot mid-turn — yields a turn with no user). */
  user?: TranscriptItem;
  /** The collapsible portion: tools, merged runs, thinking, and intermediate narration. */
  work: DisplayItem[];
  /** The turn-final assistant message(s) — the trailing run of assistant items after the
   *  last tool. Rendered visibly; the work collapses behind the "Worked for Ns" header. */
  response: DisplayItem[];
  /** Whether to offer the collapse affordance: there's real work (≥1 tool) AND a final
   *  response to keep showing once it's hidden. Turns still in flight, or that ended on a
   *  tool / pure narration, render inline instead. */
  collapsible: boolean;
  /** Turn start — the user item's timestamp (falls back to the first work item's). */
  startTs?: string;
  /** Turn end — the response's `completedAt` (falls back to its `ts`, then last work). */
  endTs?: string;
}

function itemStart(i: DisplayItem): string | undefined {
  if (i.kind === "tool") return i.startedAt ?? i.finishedAt;
  if (i.kind === "mergedTools") return i.tools[0]?.startedAt;
  if (i.kind === "user" || i.kind === "assistant") return i.ts;
  return undefined;
}
function itemEnd(i: DisplayItem): string | undefined {
  if (i.kind === "assistant") return i.completedAt ?? i.ts;
  if (i.kind === "tool") return i.finishedAt ?? i.startedAt;
  if (i.kind === "mergedTools") {
    const last = i.tools[i.tools.length - 1];
    return last?.finishedAt ?? last?.startedAt;
  }
  if (i.kind === "user") return i.ts;
  return undefined;
}

function buildTurn(
  user: TranscriptItem | undefined,
  body: DisplayItem[],
  index: number,
): TurnGroup {
  // The response is the maximal trailing run of assistant items at the very end of the
  // body — i.e. the last full assistant message(s) after the last tool. A tool (or any
  // non-assistant item) breaks the run, so anything before it stays in `work`.
  let k = body.length;
  while (k > 0 && body[k - 1]!.kind === "assistant") k--;
  const work = body.slice(0, k);
  const response = body.slice(k);
  const collapsible = response.length > 0 && work.some(isWorkTool);

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

  return {
    id: user?.id ?? body[0]?.id ?? `turn-${index}`,
    user,
    work,
    response,
    collapsible,
    startTs,
    endTs,
  };
}

export function groupTurns(
  items: readonly DisplayItem[],
  lastTurnActive = false,
): TurnGroup[] {
  const turns: TurnGroup[] = [];
  let user: TranscriptItem | undefined;
  let body: DisplayItem[] = [];
  let started = false;
  const flush = () => {
    if (!started) return;
    turns.push(buildTurn(user, body, turns.length));
    user = undefined;
    body = [];
  };
  for (const item of items) {
    if (item.kind === "user") {
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
    if (last) last.collapsible = false;
  }
  return turns;
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

/** The label for a turn's work header. Null duration (missing/!bad timestamps) → just
 *  "Worked"; a settled turn with both bounds → "Worked for Ns". */
export function workedLabel(turn: TurnGroup): string {
  const a = parseTs(turn.startTs);
  const b = parseTs(turn.endTs);
  if (a === null || b === null || b < a) return "Worked";
  return `Worked for ${formatWorkedDuration(b - a)}`;
}
