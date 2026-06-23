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

import type {
  AssistantItem,
  InjectItem,
  ToolItem,
  TranscriptItem,
} from "@pilot/protocol";

// ── Pass 1: summarize sequential tools ───────────────────────────────────────
// Every uninterrupted run of summarizable tools folds into ONE summary card,
// including a one-tool run. Write/edit/answer/image tools stay standalone and
// break the run (their side effects should be visible as separate cards).
//
// Each MergedToolsItem carries a `sealed` flag: true when a non-tool item
// (assistant text, user message, inject) has closed the run, or when
// mergeTrailing seals trailing tools at end-of-array. Rendering (in Transcript):
// a sealed run folds into the collapsible prose-summary folder (ToolSummary); an
// unsealed (still-streaming) run renders as a bare flat list of tool cards, NOT in
// a folder, so the user watches each call land before it's ever collapsed.
//
// A thinking-only assistant item normally breaks the run too — but when the "hide
// thinking" toggle is on it renders nothing, so `mergeTools(items, true)` skips it and
// the tool runs on either side fold together (no fragmenting around an invisible gap).
export const STANDALONE_TOOLS = new Set(["write", "edit"]);

// Tools whose result the USER is meant to read, not the agent's scratch work. They
// render as a visible, in-order block (see TurnGroup.visible) instead of collapsing
// into the "Worked for Ns" work block. `answer` carries the Q&A the user just filled
// in — burying it would hide their own responses.
export const VISIBLE_TOOLS = new Set(["answer"]);

/** A tool that returned image content — a screenshot, a rendered mockup, an image read.
 *  These are visual artifacts the user is meant to SEE, so they get the same treatment as
 *  VISIBLE_TOOLS: never merged into a summary run, and pulled out of the collapsible work
 *  into the always-visible slot so the picture doesn't vanish behind "Worked for Ns".
 *  Detected by the `images` field (populated at toolFinished), not by tool name, so ANY
 *  image-returning tool qualifies — `preview_screenshot`, a render tool, a read of a PNG. */
function toolHasImages(t: ToolItem): boolean {
  return (t.images?.length ?? 0) > 0;
}

function isVisibleTool(i: DisplayItem): i is ToolItem {
  return i.kind === "tool" && (VISIBLE_TOOLS.has(i.name) || toolHasImages(i));
}

export interface MergedToolsItem {
  readonly kind: "mergedTools";
  id: string;
  /** Distinct tool names in the run, in first-appearance order. */
  names: string[];
  tools: ToolItem[];
  /** True when a non-tool item (text, user message, inject) has closed this run,
   *  or when mergeTrailing sealed it at end-of-array. Sealed → the collapsible prose
   *  summary folder; unsealed → a bare flat list of tool cards (no folder). */
  sealed: boolean;
}

/** A transcript item after the merge pass — either an original item or a merged run. */
export type DisplayItem = TranscriptItem | MergedToolsItem;

function isToolItem(i: TranscriptItem): i is ToolItem {
  return i.kind === "tool";
}
/** An assistant item with no user-facing text — its only content is reasoning. When the
 *  "hide thinking" toggle is on, such an item renders nothing at all, so it's an invisible
 *  gap between tool cards. `mergeTools` treats it as transparent so the runs on either side
 *  fold into ONE card instead of fragmenting around a gap the user can't even see. */
function isHiddenOnlyThinking(i: TranscriptItem): boolean {
  return i.kind === "assistant" && i.text.trim() === "";
}
function isSummarizedTool(i: TranscriptItem): i is ToolItem {
  return (
    isToolItem(i) &&
    !STANDALONE_TOOLS.has(i.name) &&
    !VISIBLE_TOOLS.has(i.name) &&
    !toolHasImages(i)
  );
}

/** True for the two "work" item kinds the collapse treats as activity: tool cards and
 *  merged tool runs. (Used by both the merge boundary and the turn split.) */
export function isWorkTool(i: DisplayItem): boolean {
  return i.kind === "tool" || i.kind === "mergedTools";
}

export function mergeTools(
  items: readonly TranscriptItem[],
  hideThinking = false,
  /** When true (default), summarizable tools at the end of the array are sealed
   *  into a prose summary — the right call for a settled turn. When false, the trailing
   *  run stays unsealed so streaming renders it as a bare flat list (no folder) instead
   *  of collapsing it to prose before the model's text arrives. */
  mergeTrailing = true,
): DisplayItem[] {
  // ── Pass 1: group consecutive summarizable tools ──────────────────────────
  // Standalone tools break runs; everything starts unsealed.
  const result: DisplayItem[] = [];
  let pending: ToolItem[] = [];
  const buildMerged = (): MergedToolsItem => ({
    kind: "mergedTools",
    id: pending[0]!.id,
    names: [...new Set(pending.map((t) => t.name))],
    tools: pending,
    sealed: false, // Pass 2 will promote to true where warranted
  });
  const flush = () => {
    if (pending.length === 0) return;
    result.push(buildMerged());
    pending = [];
  };

  for (const item of items) {
    if (isSummarizedTool(item)) {
      pending.push(item);
    } else if (hideThinking && isHiddenOnlyThinking(item)) {
      continue;
    } else {
      // Any non-summarizable-tool item (standalone tool, or non-tool) breaks the
      // run. Don't seal yet — Pass 2 decides that based on what follows.
      flush();
      result.push(item);
    }
  }
  flush();

  // ── Pass 2: seal runs that are followed by non-tool content ──────────────
  // A merged run is "sealed" when a non-tool item (text, user message, inject)
  // eventually follows it — the model emitted something after those tools. Standalone
  // tool cards (write/edit/…) between the run and the text don't prevent sealing;
  // they're more tools, not model prose.
  for (let i = 0; i < result.length; i++) {
    const item = result[i]!;
    if (item.kind !== "mergedTools" || item.sealed) continue;
    // Look ahead for a non-tool, non-mergedTools item. Skip past any standalone
    // tools (write/edit/answer/images) and past other merged runs.
    let seal = false;
    for (let j = i + 1; j < result.length; j++) {
      const next = result[j]!;
      if (next.kind === "mergedTools") continue;
      if (next.kind !== "tool") {
        seal = true;
        break;
      }
      // Standalone tool — keep looking
    }
    // mergeTrailing seals the very last run even if nothing follows.
    if (!seal && mergeTrailing && i === lastMergedIndex(result)) {
      seal = true;
    }
    if (seal) result[i] = { ...item, sealed: true };
  }

  return result;
}

/** Index of the rightmost MergedToolsItem in the array, or -1. */
function lastMergedIndex(result: DisplayItem[]): number {
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]!.kind === "mergedTools") return i;
  }
  return -1;
}

// ── Skill-load detection ─────────────────────────────────────────────────────
// pi has no model-facing "skill" tool: its system prompt lists the available skills
// with their `<location>` and instructs the model to *read the SKILL.md* when a task
// matches. So a skill load surfaces as an ordinary `read` of a `SKILL.md`. We detect
// that shape so the summary can say "loaded skill X" instead of "read a file".

/** The file path a `read` tool targeted, or null if it isn't a path-bearing read. */
function readPath(t: ToolItem): string | null {
  if (t.name !== "read") return null;
  const inp = t.input;
  if (!inp || typeof inp !== "object") return null;
  const o = inp as Record<string, unknown>;
  if (typeof o.path === "string") return o.path;
  if (typeof o.file_path === "string") return o.file_path;
  return null;
}

/**
 * If a tool is a `read` of a `SKILL.md`, return the skill's name (its parent directory,
 * matching pi's own `name = parentDirName` convention); otherwise null. Heuristic by
 * design: reading a SKILL.md you're *editing* also matches, an acceptable false positive
 * — the dominant meaning of "read a SKILL.md" is "load that skill". Only SKILL.md files
 * are detectable; root `.md` skills are indistinguishable from any other markdown read.
 */
export function skillFromTool(t: ToolItem): string | null {
  const p = readPath(t);
  if (!p) return null;
  const parts = p.split("/").filter(Boolean);
  const base = parts[parts.length - 1];
  if (!base || base.toLowerCase() !== "skill.md") return null;
  return parts[parts.length - 2] ?? "skill";
}

// ── Programmatic prose summary for a merged tool run ──────────────────────────
// Maps each tool to a friendly "category" with a count-aware phrase, groups the run by
// category (first-appearance order), and joins into one sentence — e.g.
// "Edited a file, read 2 files, ran 3 commands". This is the deterministic, no-LLM
// stand-in for the intent prose Codex/Claude generate. Skill loads get their own
// category so the prose can name the skill.

interface ToolCategory {
  key: string;
  /** Builds the phrase from the bucket's count and (for skills) collected names. */
  phrase: (count: number, names: string[]) => string;
  /** Set only for skill loads; collected so a single-skill run can name it. */
  skillName?: string;
}

function toolCategory(t: ToolItem): ToolCategory {
  const skill = skillFromTool(t);
  if (skill) {
    return {
      key: "skill",
      skillName: skill,
      phrase: (n, names) =>
        n === 1 ? `loaded skill ${names[0]}` : `loaded ${n} skills`,
    };
  }
  switch (t.name) {
    case "read":
      return {
        key: "read",
        phrase: (n) => (n === 1 ? "read a file" : `read ${n} files`),
      };
    case "edit":
      return {
        key: "edit",
        phrase: (n) => (n === 1 ? "edited a file" : `edited ${n} files`),
      };
    case "write":
      return {
        key: "write",
        phrase: (n) => (n === 1 ? "wrote a file" : `wrote ${n} files`),
      };
    case "bash":
      return {
        key: "bash",
        phrase: (n) => (n === 1 ? "ran a command" : `ran ${n} commands`),
      };
    case "grep":
    case "ripgrep":
    case "find":
      // grep (content) and find (filenames) both read as "searches" in a summary.
      return {
        key: "search",
        phrase: (n) => (n === 1 ? "ran a search" : `ran ${n} searches`),
      };
    case "ls":
      return {
        key: "ls",
        phrase: (n) =>
          n === 1 ? "listed a directory" : `listed ${n} directories`,
      };
    default: {
      // Unknown tool: fall back to its name as the verb-noun so nothing is silently dropped.
      const label = t.name;
      return {
        key: `other:${label}`,
        phrase: (n) => (n === 1 ? `used ${label}` : `used ${label} ${n}×`),
      };
    }
  }
}

/** Prose summary of a run of tools: "Edited a file, read 2 files, ran 3 commands".
 *  Skill-aware (reads of SKILL.md become "loaded skill X"), grouped by category in
 *  first-appearance order, with only the first letter of the whole sentence capitalized. */
export function summarizeToolRun(tools: readonly ToolItem[]): string {
  const buckets = new Map<
    string,
    { count: number; names: string[]; phrase: ToolCategory["phrase"] }
  >();
  for (const t of tools) {
    const cat = toolCategory(t);
    let b = buckets.get(cat.key);
    if (!b) {
      b = { count: 0, names: [], phrase: cat.phrase };
      buckets.set(cat.key, b);
    }
    b.count++;
    if (cat.skillName) b.names.push(cat.skillName);
  }
  const joined = [...buckets.values()]
    .map((b) => b.phrase(b.count, b.names))
    .join(", ");
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : "";
}

/** Human label for a merged card — the programmatic prose summary of its tools. */
export function mergedSummary(item: MergedToolsItem): string {
  return summarizeToolRun(item.tools);
}

// ── Pass 2: group into turns and split work vs. response ─────────────────────

export interface TurnGroup {
  /** Stable key for the turn (the user item's id, else the first item's, else index). */
  id: string;
  /** The item that opened the turn, if any: a user prompt, or an injected custom
   *  message (a nudge) that triggered a fresh run. A leading run before the first such
   *  item — e.g. a snapshot mid-turn — yields a turn with no head. */
  user?: TranscriptItem;
  /** The collapsible portion: tools, merged runs, thinking, and intermediate narration. */
  work: DisplayItem[];
  /** Always-visible items pulled out of `work` — the `answer` tool's Q&A result (see
   *  VISIBLE_TOOLS) and any image-bearing tool (see toolHasImages: a screenshot, a
   *  rendered mockup). Rendered between the collapsed work block and the final response
   *  so the user's own answers — and the pictures the agent surfaced — don't hide. */
  visible: DisplayItem[];
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
  if (i.kind === "user" || i.kind === "assistant" || i.kind === "inject")
    return i.ts;
  return undefined;
}
function itemEnd(i: DisplayItem): string | undefined {
  if (i.kind === "assistant") return i.completedAt ?? i.ts;
  if (i.kind === "tool") return i.finishedAt ?? i.startedAt;
  if (i.kind === "mergedTools") {
    const last = i.tools[i.tools.length - 1];
    return last?.finishedAt ?? last?.startedAt;
  }
  if (i.kind === "user" || i.kind === "inject") return i.ts;
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
  // Pull always-visible tools (the answer Q&A, plus any image-bearing tool — a
  // screenshot or rendered mockup) out of the work portion so they never collapse.
  // They're rendered after the work block, before the response — chronologically
  // right for the common "ask/show → final response" tail.
  const workItems = body.slice(0, k);
  const visible = workItems.filter(isVisibleTool);
  const work = workItems.filter((i) => !isVisibleTool(i));
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
    visible,
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
    // A user prompt OR an injected custom message opens a new turn. The inject case is
    // the fix for extension nudges (e.g. journal-nudge): pi's sendMessage triggers a
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
    if (last) last.collapsible = false;
  }
  return turns;
}

// ── Injected custom-message (nudge) rendering ────────────────────────────────
export function isInjectItem(i: DisplayItem): i is InjectItem {
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

/** The label for a turn's work header. Null duration (missing/!bad timestamps) → just
 *  "Worked"; a settled turn with both bounds → "Worked for Ns". */
export function workedLabel(turn: TurnGroup): string {
  const a = parseTs(turn.startTs);
  const b = parseTs(turn.endTs);
  if (a === null || b === null || b < a) return "Worked";
  return `Worked for ${formatWorkedDuration(b - a)}`;
}

// ── Answer (Q&A) result rendering ────────────────────────────────────────────

/** Extract plain text from a tool's `output`. Live results arrive as pi's raw
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
