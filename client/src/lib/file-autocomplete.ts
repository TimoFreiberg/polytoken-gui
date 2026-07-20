// Pure helpers for the composer's @-reference typeahead. Kept DOM-free so they
// can be unit-tested directly: `extractAtQuery` decides whether the cursor is inside
// a `@`-prefix token and returns the query text + the `@` position for replacement;
// `classifyAtQuery` further classifies that query text into a kind (file/skill/
// subagent/model/external); `filterFiles`/`filterNames`/`filterModels` rank each
// candidate source against a query for instant local matching (no server round-trip);
// `buildAtItems` composes all of the above into the ordered list the menu renders.

import type { FileInfo, ModelOption } from "@pantoken/protocol";

/** Characters that delimit a token boundary — a `@` is only a mention prefix when
 *  it starts a new token (i.e. preceded by whitespace / start of line, NOT in the
 *  middle of a word like `email@domain`). */
const TOKEN_BREAKS = new Set([" ", "\t", "\n", "\r", ",", ";", "(", "[", "{"]);

/** Cap on @-mention file rows rendered in the menu. Shared between `buildAtItems`
 *  (the live menu builder) and `staleServerFiles` (the stale-while-revalidate
 *  re-filter, which must cap at the same limit so stale results don't overflow the
 *  menu). The Composer imports this constant directly. */
export const AT_MENU_LIMIT = 50;

/** The result of extracting an active @-mention from the draft. */
export interface AtQuery {
  /** Text after the `@` (empty when the user just typed `@` and hasn't started a
   *  filename yet — show the full file list). */
  query: string;
  /** Position of the `@` character in the draft (0-indexed), so the Composer can
   *  replace `@<query>` with the selected file path. */
  atPos: number;
}

/**
 * Extract the @-mention at or before the cursor position.
 * Returns null when the cursor isn't inside a `@`-mention token — e.g.:
 *   - draft is empty or doesn't contain `@`
 *   - `@` is at position 0 AND the text starts with `/` (slash mode takes priority)
 *   - `@` is embedded in a word like `email@domain`
 *   - no `@` exists before the cursor
 *
 * The cursor position (0-indexed) is `textarea.selectionStart`. We scan backward
 * from the cursor, find the nearest `@` that sits at a token boundary, and return
 * everything after it verbatim (interior text preserved, never trimmed). A mention
 * token can't span whitespace, so any whitespace between the `@` and the cursor
 * means the mention already ended and we return null. An empty `query` means the
 * user just typed `@` and hasn't started a filename yet — show the full list.
 */
export function extractAtQuery(
  draft: string,
  cursorPos: number,
): AtQuery | null {
  if (!draft) return null;

  // Clamp cursor to the draft length (defends against stale cursor values).
  const pos = Math.min(cursorPos, draft.length);

  // Slash mode at the start takes priority — a leading `@` without a slash
  // is still a file mention, but `/` + anything means it's a command.
  if (draft.startsWith("/")) {
    // Check whether the cursor is in the leading-slash token (no space yet).
    const firstSpace = draft.indexOf(" ");
    const cmdEnd = firstSpace === -1 ? draft.length : firstSpace;
    if (pos <= cmdEnd) return null; // still typing the slash command
  }

  // Scan backward from the cursor for a `@`.
  for (let i = pos - 1; i >= 0; i--) {
    if (draft[i] !== "@") continue;

    // Check that this `@` is at a token boundary (preceded by nothing
    // or a break character). This prevents matching `email@domain`.
    const before = i === 0 ? null : draft[i - 1]!;
    if (before !== null && !TOKEN_BREAKS.has(before)) continue;

    // Extract the text between `@` (exclusive) and cursor (exclusive).
    const afterAt = draft.slice(i + 1, pos);

    // A mention token terminates at whitespace: once the user types a space
    // after `@foo`, the mention is done and the cursor sits in plain prose.
    // Returning null here keeps the menu closed and — crucially — stops the
    // debounced server query from re-firing `fd` over the whole growing tail
    // of the message after every accepted mention.
    if (/\s/.test(afterAt)) return null;

    return { query: afterAt, atPos: i };
  }

  return null;
}

/** Characters that delimit "word boundaries" within a path segment — a fuzzy
 *  match starting right after one of these (or at a `/` segment boundary, or at
 *  the start of the path) earns a boundary bonus, mirroring polytoken's TUI
 *  ranking where segment-prefix and word-prefix matches outrank interior ones. */
const WORD_BOUNDARIES = new Set(["-", "_", ".", " "]);

/** The result of scoring a single path against a query via fuzzy subsequence
 *  matching. `null` means no match (the query chars don't appear in order). */
interface FuzzyScore {
  /** Best match tier: 0 = path-prefix, 1 = basename/segment-prefix, 2 = fuzzy. */
  tier: number;
  /** Fuzzy score: higher is better. Bonuses for consecutive matches, boundary
   *  starts, and early match positions. Used for tie-breaking within a tier. */
  score: number;
  /** Path length (shorter = better, for tie-breaking). */
  len: number;
}

/**
 * Score a path against a query using fuzzy subsequence matching (case-insensitive).
 * Each query character must appear in the path in order; the scorer finds the
 * best-scoring alignment and returns its tier + score, or null if no subsequence
 * match exists.
 *
 * Scoring (mirrors polytoken's TUI behavior as observed via the parity harness):
 * - **Tier 0 (path-prefix):** the query matches the start of the full path.
 * - **Tier 1 (basename/segment-prefix):** the query matches the start of a path
 *   segment (the basename or any interior segment's first chars).
 * - **Tier 2 (fuzzy):** the query is a subsequence but doesn't start at any
 *   segment boundary.
 *
 * Within a tier, the fuzzy score rewards:
 * - Consecutive matches (each run of adjacent chars gets a compounding bonus)
 * - Boundary starts (match at path start, after `/`, or after `-_.` separators)
 * - Early match positions (earlier = better)
 *
 * This replaces pantoken's former substring `indexOf` matcher with a fzf-style
 * subsequence scorer, aligning with polytoken's TUI which does fuzzy matching
 * (verified via the at-mention fixture comparison — e.g. `@srselrs` matches
 * `src/selection.rs`, `@servre` matches `docs/server-selection-rest-api.md`).
 */
function fuzzyScore(path: string, q: string): FuzzyScore | null {
  if (q.length === 0) return { tier: 0, score: 0, len: path.length };
  if (q.length > path.length) return null;

  const n = path.length;
  const m = q.length;

  // Find the leftmost subsequence match (greedy: earliest possible position
  // for each query char). This is O(n*m) but n,m are small (paths < 200, queries < 50).
  const matchPositions: number[] = [];
  let pi = 0; // path index
  for (let qi = 0; qi < m; qi++) {
    const qc = q[qi]!;
    while (pi < n && path[pi] !== qc) pi++;
    if (pi >= n) return null; // no match for this char
    matchPositions.push(pi);
    pi++; // advance past this match for the next char
  }

  // Determine the tier based on where the match starts:
  //   0 = path-prefix (the query is a contiguous substring at position 0)
  //   1 = basename-prefix (the query is a contiguous substring at the start of the basename)
  //   2 = segment-prefix (the query is a contiguous substring at the start of an interior segment)
  //   3 = word-boundary (the query is a contiguous substring after a '-_. ' separator)
  //   4 = fuzzy (subsequence match only, no contiguous boundary alignment)
  //
  // For tiers 0-3 we check whether the query appears as a contiguous substring
  // at a boundary position — a fuzzy subsequence that happens to start at a
  // boundary but isn't contiguous (e.g. "server" matching "s" at pos 0 of
  // "src/server") does NOT qualify as a prefix match.
  const lastSlash = path.lastIndexOf("/");
  const basenameStart = lastSlash + 1; // 0 when no slash
  const basename = path.slice(basenameStart);

  let tier: number;
  if (path.startsWith(q)) {
    tier = 0; // path-prefix (contiguous)
  } else if (basename.startsWith(q)) {
    tier = 1; // basename-prefix (contiguous)
  } else {
    // Check if the query is a contiguous substring at any segment boundary.
    let segmentPrefix = false;
    for (let i = 0; i < basenameStart; i++) {
      if (path[i] === "/" && path.startsWith(q, i + 1)) {
        segmentPrefix = true;
        break;
      }
    }
    if (segmentPrefix) {
      tier = 2; // segment-prefix (contiguous at an interior segment start)
    } else {
      // Check word-boundary: query is a contiguous substring after a separator.
      const wbIdx = path.indexOf(q);
      if (wbIdx > 0 && WORD_BOUNDARIES.has(path[wbIdx - 1]!)) {
        tier = 3; // word-boundary
      } else {
        tier = 4; // fuzzy (subsequence only)
      }
    }
  }

  // Compute the fuzzy score for tie-breaking within a tier.
  // Rewards consecutive matches, boundary positions, and early alignment.
  let score = 0;
  let consecutive = 0;
  for (let i = 0; i < matchPositions.length; i++) {
    const pos = matchPositions[i]!;
    const prevPos = i > 0 ? matchPositions[i - 1]! : -2;

    // Consecutive match bonus (compounding for runs of adjacent chars).
    if (pos === prevPos + 1) {
      consecutive++;
      score += 10 + consecutive * 5;
    } else {
      consecutive = 0;
      score += 1;
    }

    // Boundary bonus: match at path start, after '/', or after a word separator.
    if (pos === 0 || path[pos - 1] === "/") {
      score += 20; // segment boundary
    } else if (pos > 0 && WORD_BOUNDARIES.has(path[pos - 1]!)) {
      score += 10; // word boundary within segment
    }

    // Earlier matches score higher (penalize late positions).
    score -= pos * 0.1;
  }

  return { tier, score, len: path.length };
}

/**
 * Rank the prefetched file index against an @-mention query, for instant client-side
 * matching. Uses fuzzy subsequence matching (case-insensitive) — each query character
 * must appear in the path in order, but not necessarily contiguously. This mirrors
 * polytoken's TUI autocomplete, which does fzf-style fuzzy matching (verified via the
 * at-mention fixture comparison: `@srselrs` → `src/selection.rs`, `@servre` →
 * `docs/server-selection-rest-api.md`).
 *
 * Ranking, best first:
 *   1. **Path-prefix** — the query matches the start of the full path (`server` → `server.rs`)
 *   2. **Basename-prefix** — the query matches the start of the last path segment
 *      (`server` → `caps/Server.rs`, `docs/server-selection-rest-api.md`)
 *   3. **Segment-prefix** — the query matches the start of an interior path segment
 *      (`server` → `src/server/`)
 *   4. **Word-boundary** — the query matches after a `-_.` separator within a segment
 *   5. **Fuzzy** — the query is a subsequence match but doesn't start at any boundary
 *      (`srselrs` → `src/selection.rs`)
 *
 * Within a tier, ties break by fuzzy score for fuzzy matches (tier 4: consecutive
 * matches, boundary starts, early positions), then alphabetically by path for
 * prefix matches (tiers 0-3). No directory-before-file preference — polytoken
 * ranks same-tier matches purely alphabetically (verified via the at-mention
 * fixture: `@server` puts the file `server.rs` before the dir `src/server/`).
 *
 * An empty query returns the head of the index (it's already in fd's order) — the bare-`@`
 * list. Results are capped at `limit`.
 *
 * A trailing slash in the query (`index/`) is treated as a directory drill-down:
 * the matching directory and its immediate children are shown.
 */
export function filterFiles(
  files: readonly FileInfo[],
  query: string,
  limit = 50,
): FileInfo[] {
  if (!query) return files.slice(0, limit);

  // Trailing-slash drill-down: show the matching directory + its children.
  if (query.endsWith("/")) {
    const dirQuery = query.slice(0, -1).toLowerCase();
    const matched: FileInfo[] = [];
    for (const f of files) {
      const path = f.path.toLowerCase();
      // The directory itself.
      if (path === dirQuery && f.isDirectory) {
        matched.push(f);
        continue;
      }
      // Immediate children: path starts with "dirQuery/" and has no further '/'.
      if (path.startsWith(dirQuery + "/")) {
        const rest = path.slice(dirQuery.length + 1);
        if (!rest.includes("/")) {
          matched.push(f);
        }
      }
    }
    return matched.slice(0, limit);
  }

  const q = query.toLowerCase();

  const scored: { f: FileInfo; tier: number; score: number; len: number }[] = [];
  for (const f of files) {
    const path = f.path.toLowerCase();
    const result = fuzzyScore(path, q);
    if (!result) continue;
    scored.push({ f, tier: result.tier, score: result.score, len: result.len });
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    // For fuzzy matches (tier 4), score determines the order (higher = better
    // alignment: consecutive chars, boundary starts, early positions). For
    // prefix matches (tiers 0-3), polytoken ranks same-tier matches purely
    // alphabetically by path — no length or directory preference (verified
    // via the at-mention fixture: @s puts server.rs before src/ despite src/
    // being shorter; @server puts caps/Server.rs before src/server/).
    if (a.tier === 4 && a.score !== b.score) return b.score - a.score;
    return a.f.path.localeCompare(b.f.path);
  });

  return scored.slice(0, limit).map((s) => s.f);
}

/** The mode of an active @-mention that uses the server-backed file query —
 *  `"external"` for `@~/`, `@/`, `@../` (server-only: no local index outside the
 *  project), `"project"` for project-mode when it falls back to the server search
 *  (truncated index, drafting a new session, or Shift+Tab ignore-toggle on). */
export type ServerFileMode = "external" | "project";

/** A cached snapshot of the last fresh server file results, captured for the
 *  stale-while-revalidate display so the @-mention menu doesn't blank during the
 *  in-flight window between a keystroke and the debounced server response. */
export interface CachedServerFiles {
  /** The file items the server returned. */
  files: readonly FileInfo[];
  /** The `atQ` these results answered (the full text after `@`). */
  query: string;
  /** The `ignoreOff` (Shift+Tab) toggle state the server responded with. */
  includeIgnored: boolean;
  /** The mention mode these results belong to — prevents external↔project bleed. */
  mode: ServerFileMode;
}

/** The fresh server file state from `store.files` — the latest server response,
 *  `{ items, query, includeIgnored }`. `query` is the server-echoed query from the
 *  response, so comparing it to the current `atQ` tells us whether these results are
 *  fresh (match) or stale (in-flight). */
export interface FreshServerFiles {
  items: readonly FileInfo[];
  query: string;
  includeIgnored: boolean;
}

/**
 * Mirror the server's `split_external_query`: split an external `atQ` into its
 * directory prefix (everything before the last `/`) and trailing partial
 * (everything after). A slash-free query (`~`, `..`, `notes`) is entirely the
 * directory prefix with an empty partial. A leading root slash (e.g. `/etc`) keeps
 * `/` as the dir-prefix when that's the only slash, rather than collapsing to `""`.
 *
 * Used to (a) guard against a directory drill-down returning stale parent-dir
 * results, and (b) re-filter only by the trailing partial (the directory's children
 * match the partial, not the full `~/proj` path).
 */
export function splitExternalQuery(query: string): {
  dirPrefix: string;
  partial: string;
} {
  const idx = query.lastIndexOf("/");
  if (idx === -1) return { dirPrefix: query, partial: "" };
  let dirPrefix = query.slice(0, idx);
  // A leading root slash (e.g. "/etc") — keep "/" rather than collapsing to "".
  if (dirPrefix === "" && query.startsWith("/")) dirPrefix = "/";
  return { dirPrefix, partial: query.slice(idx + 1) };
}

/**
 * Stale-while-revalidate for the server-backed @-mention menu. Returns the file
 * items to display right now:
 *
 *   - **Fresh match** — `fresh.query === atQ && fresh.includeIgnored === ignoreOff`:
 *     the latest server response is for exactly the current query + toggle state.
 *     Return `fresh.items` (the caller's capture effect will cache them).
 *
 *   - **Stale but usable** — no fresh match, but a `cached` snapshot exists with the
 *     same `mode` and `includeIgnored`: the user typed another letter (or toggled
 *     nothing) and a new response is in-flight. Re-filter the cached items against
 *     the current query so only still-relevant entries stay visible — the menu
 *     stays populated instead of blanking.
 *       - **project mode**: cached results are full-tree path matches, so re-filter
 *         by the full `atQ` via `filterFiles`.
 *       - **external mode**: cached results are one browsed directory's children.
 *         A **directory-prefix guard** compares the current `atQ`'s dir-prefix to
 *         the cached query's — if they differ (a drill-down into a different
 *         directory), the old results are the *parent* dir's children and are
 *         invalid → return `[]`. Otherwise re-filter by the trailing partial only
 *         (after the last `/`), since the children match the partial, not the full
 *         `~/proj` path.
 *
 *   - **No usable cache** — `cached` is `null`, or its `mode`/`includeIgnored`
 *     doesn't match: return `[]` (first keystroke on a fresh mention, after
 *     invalidation, cross-mode/cross-toggle transition, or an external dir-prefix
 *     mismatch). The menu is empty until the first response arrives — correct, not
 *     a flicker.
 *
 * Extracted as a pure function so the stale-while-revalidate logic is unit-testable
 * without a Svelte component harness.
 */
export function staleServerFiles(
  fresh: FreshServerFiles,
  cached: CachedServerFiles | null,
  atQ: string,
  mode: ServerFileMode,
  ignoreOff: boolean,
): readonly FileInfo[] {
  // Fresh match — the latest server response answers the current query + toggle.
  if (fresh.query === atQ && fresh.includeIgnored === ignoreOff) {
    return fresh.items;
  }

  // In-flight: re-filter the cached results, if they're still valid for this
  // mode + toggle combination.
  if (
    cached !== null &&
    cached.mode === mode &&
    cached.includeIgnored === ignoreOff
  ) {
    if (mode === "external") {
      const cachedSplit = splitExternalQuery(cached.query);
      const currentSplit = splitExternalQuery(atQ);
      // Directory drill-down guard: the cached results are one directory's
      // children. If the current query browses a different directory, the cached
      // children are the *parent* dir's and must not show — return [].
      if (cachedSplit.dirPrefix !== currentSplit.dirPrefix) return [];
      // Same directory — re-filter by the trailing partial only. The children
      // match the partial (e.g. "pr"), not the full `~/pr` path.
      return filterFiles(cached.files, currentSplit.partial, AT_MENU_LIMIT);
    }
    // project mode: full-tree path matches — re-filter by the full atQ.
    return filterFiles(cached.files, atQ, AT_MENU_LIMIT);
  }

  return [];
}

/** Which kind of reference an @-mention query resolves to, and the text left over
 *  once the kind's sigil (if any) is stripped.
 *
 * Sigils are literal, case-sensitive, lowercase prefixes — `Skill:` or `S:` do NOT
 * match (they fall through to `project`, same as any other query that isn't a
 * recognized sigil or external-path lead-in). The long form (`skill:`) and the
 * shorthand (`s:`) both classify to the same mode; canonical insertion always
 * writes the long form regardless of which one the user typed.
 *
 * External paths (`/`, `~`, `..`) are recognized here so the composer can suppress
 * project-file candidates for them; resolving actual external candidates happens
 * server-side (the composer always server-queries for this mode — see the
 * `queryFiles` effect in `Composer.svelte`), so `buildAtItems` just maps whatever
 * the server returned into file rows.
 */
export type AtQueryClass =
  | { mode: "skill"; partial: string }
  | { mode: "subagent"; partial: string }
  | { mode: "model"; partial: string }
  | { mode: "external"; raw: string }
  | { mode: "project"; partial: string };

export function classifyAtQuery(query: string): AtQueryClass {
  if (query.startsWith("skill:"))
    return { mode: "skill", partial: query.slice(6) };
  if (query.startsWith("s:")) return { mode: "skill", partial: query.slice(2) };
  if (query.startsWith("subagent:"))
    return { mode: "subagent", partial: query.slice(9) };
  if (query.startsWith("a:"))
    return { mode: "subagent", partial: query.slice(2) };
  if (query.startsWith("model:"))
    return { mode: "model", partial: query.slice(6) };
  if (query.startsWith("m:")) return { mode: "model", partial: query.slice(2) };
  if (query.startsWith("/") || query.startsWith("~") || query.startsWith(".."))
    return { mode: "external", raw: query };
  return { mode: "project", partial: query };
}

/** One row the @-reference menu can render. A discriminated union so `AtMenu` can
 *  switch on `kind` for rendering and `Composer.acceptAtItem` can switch on it for
 *  canonical insertion text. */
export type AtItem =
  | { kind: "file"; file: FileInfo }
  | { kind: "skill"; name: string }
  | { kind: "subagent"; name: string }
  | { kind: "model"; model: ModelOption }
  | { kind: "sigil"; prefix: "skill:" | "subagent:" | "model:"; label: string };

/**
 * Rank a flat name list (skills, subagents) against a partial query, for the
 * kind-takeover (`@skill:`) and appended-badged-match (bare `@foo`) cases.
 * Case-insensitive substring match; name-start matches rank before interior
 * matches, ties break alphabetically. An empty partial returns the head of the
 * list as-given (mirrors `filterFiles`'s bare-`@` behavior).
 */
export function filterNames(
  names: readonly string[],
  partial: string,
  limit = 50,
): string[] {
  if (!partial) return names.slice(0, limit);
  const q = partial.toLowerCase();

  const scored: { name: string; rank: number }[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const at = lower.indexOf(q);
    if (at === -1) continue;
    scored.push({ name, rank: at === 0 ? 0 : 1 });
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });

  return scored.slice(0, limit).map((s) => s.name);
}

/**
 * Rank the available models against a partial query, for `@model:`/`@m:` takeover
 * and appended badged matches. Matches against `label`, `modelId`, and
 * `provider/modelId` (so "sonnet", "claude-sonnet-4-6", and "anthropic/claude"
 * all hit); ranks a `modelId`-start match first, then alphabetical by `modelId`.
 * An empty partial returns the head of the list as-given.
 */
export function filterModels(
  models: readonly ModelOption[],
  partial: string,
  limit = 50,
): ModelOption[] {
  if (!partial) return models.slice(0, limit);
  const q = partial.toLowerCase();

  const scored: { m: ModelOption; rank: number }[] = [];
  for (const m of models) {
    const modelId = m.modelId.toLowerCase();
    const label = m.label.toLowerCase();
    const providerModel = `${m.provider}/${m.modelId}`.toLowerCase();
    if (
      !modelId.includes(q) &&
      !label.includes(q) &&
      !providerModel.includes(q)
    )
      continue;
    scored.push({ m, rank: modelId.startsWith(q) ? 0 : 1 });
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.m.modelId.localeCompare(b.m.modelId);
  });

  return scored.slice(0, limit).map((s) => s.m);
}

/** Sigil rows offered at the end of a project-mode, non-empty-partial menu — the
 *  "keep narrowing" affordance that makes the other kinds discoverable. `model:` is
 *  always offered (models are a fixed, always-available source); `skill:`/
 *  `subagent:` are only offered when their source list is non-empty (an empty
 *  fixture/session has nothing to browse into). */
const SIGILS: readonly {
  prefix: "skill:" | "subagent:" | "model:";
  label: string;
}[] = [
  { prefix: "skill:", label: "browse skills…" },
  { prefix: "subagent:", label: "browse subagents…" },
  { prefix: "model:", label: "browse models…" },
];

/** Whether a sigil's kind has anything to browse into. `model:` is always available
 *  (models are a fixed, always-available source); `skill:`/`subagent:` need a
 *  non-empty source list (an empty fixture/session has nothing to browse into). */
function sigilAvailable(
  prefix: "skill:" | "subagent:" | "model:",
  skills: readonly string[],
  subagents: readonly string[],
): boolean {
  if (prefix === "model:") return true;
  if (prefix === "skill:") return skills.length > 0;
  return subagents.length > 0;
}

/**
 * Step a model's reasoning-level selection while a model row is highlighted in the
 * `@model:`/`@m:` picker — `]` (`dir = 1`) steps up, `[` (`dir = -1`) steps down.
 * `null` means "no level chosen", which is both the picker's starting state and the
 * floor: stepping down from `levels[0]` returns to `null` rather than wrapping to the
 * top. Stepping up clamps at `levels.at(-1)` rather than wrapping back to `null` —
 * the two directions are deliberately asymmetric (repeatedly pressing `]` settles at
 * max reasoning instead of cycling past it back to "unset"), matching the polytoken
 * TUI. A model with no `thinkingLevels` (or an empty list) always yields `null` —
 * there's nothing to select. A `current` value that isn't one of `levels` (stale,
 * e.g. leftover from a differently-leveled model) is treated the same as `null`.
 */
export function stepLevel(
  levels: readonly string[] | undefined,
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (!levels || levels.length === 0) return null;
  const idx = current === null ? -1 : levels.indexOf(current);
  if (dir === 1) {
    const next = Math.min(idx + 1, levels.length - 1);
    return levels[next] ?? null;
  }
  const next = idx - 1;
  return next < 0 ? null : (levels[next] ?? null);
}

export interface BuildAtItemsParams {
  /** The full text after `@` (before any sigil stripping) — classified internally. */
  query: string;
  /** The prefetched local file index (project mode only; ignored otherwise). */
  files: readonly FileInfo[];
  /** Extra file matches from the server fallback search (project mode only), already
   *  filtered to the current query by the caller. */
  serverFiles: readonly FileInfo[];
  skills: readonly string[];
  subagents: readonly string[];
  models: readonly ModelOption[];
  /** Cap on file results (project mode) and on takeover-mode kind lists. Appended
   *  badged matches in project mode are always capped at 5 per kind, regardless. */
  limit?: number;
}

/**
 * Build the ordered @-reference menu items for one query, composing
 * `classifyAtQuery` + the per-kind filters into the single list `AtMenu` renders.
 *
 *   - skill/subagent/model: full takeover — only that kind's matches.
 *   - external (`~/…`, `/…`, `../…`): full takeover — the server-resolved `serverFiles`
 *     for the current query, mapped straight to file rows (see the `queryFiles`
 *     effect in `Composer.svelte`, which always fires for this mode).
 *   - project, empty partial (bare `@`): files only — no kind noise; the footer
 *     hint advertises the sigils instead.
 *   - project, non-empty partial: file matches (local ranked + server extras,
 *     deduped, capped at `limit`), then name-matching skills/subagents/models
 *     (badged, capped at 5 each), then sigil rows for any sigil that starts with
 *     the partial — sigils always last, so Enter-on-first-item still picks the
 *     best file.
 */
export function buildAtItems(params: BuildAtItemsParams): AtItem[] {
  const {
    query,
    files,
    serverFiles,
    skills,
    subagents,
    models,
    limit = 50,
  } = params;
  const cls = classifyAtQuery(query);

  if (cls.mode === "skill") {
    return filterNames(skills, cls.partial, limit).map((name): AtItem => ({
      kind: "skill",
      name,
    }));
  }
  if (cls.mode === "subagent") {
    return filterNames(subagents, cls.partial, limit).map((name): AtItem => ({
      kind: "subagent",
      name,
    }));
  }
  if (cls.mode === "model") {
    return filterModels(models, cls.partial, limit).map((model): AtItem => ({
      kind: "model",
      model,
    }));
  }
  if (cls.mode === "external") {
    // The server is the only source for external paths — it lists the immediate
    // children of the directory being browsed (`server-rs/.../file_search.rs::list_external`
    // for a real session, the mock's synthetic external tree for dev/e2e). No local
    // index involvement (there isn't one outside the project), no badged kind
    // matches, no sigils — just the as-typed file/dir rows the server returned for
    // the current query. The caller (Composer.svelte) passes `serverFilesStale`,
    // which is either the fresh `store.files.items` (when the echo guard
    // `store.files.query === atQ` matches) or the re-filtered stale cache (during
    // the in-flight window) — see `staleServerFiles` for the contract.
    return serverFiles
      .slice(0, limit)
      .map((file): AtItem => ({ kind: "file", file }));
  }

  // cls.mode === "project"
  const partial = cls.partial;
  const localMatches = filterFiles(files, partial, limit);
  const seen = new Set(localMatches.map((f) => f.path));
  const mergedFiles: FileInfo[] = [...localMatches];
  for (const f of serverFiles) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    mergedFiles.push(f);
  }
  const items: AtItem[] = mergedFiles
    .slice(0, limit)
    .map((file): AtItem => ({ kind: "file", file }));

  if (partial === "") {
    if (items.length > 0) return items; // bare @ with files: no kind noise, no sigils
    // No file candidates at all for a bare `@` (empty/unindexed cwd) — an empty menu
    // would hide every other kind. Fall back to the sigil rows (still honoring the
    // "suppress sigils for an empty source list" rule below) so the other kinds stay
    // discoverable instead of the picker just not opening.
    return SIGILS.filter((sigil) =>
      sigilAvailable(sigil.prefix, skills, subagents),
    ).map((sigil): AtItem => ({
      kind: "sigil",
      prefix: sigil.prefix,
      label: sigil.label,
    }));
  }

  const KIND_LIMIT = 5;
  for (const name of filterNames(skills, partial, KIND_LIMIT)) {
    items.push({ kind: "skill", name });
  }
  for (const name of filterNames(subagents, partial, KIND_LIMIT)) {
    items.push({ kind: "subagent", name });
  }
  for (const model of filterModels(models, partial, KIND_LIMIT)) {
    items.push({ kind: "model", model });
  }

  for (const sigil of SIGILS) {
    const available = sigilAvailable(sigil.prefix, skills, subagents);
    if (available && sigil.prefix.startsWith(partial)) {
      items.push({ kind: "sigil", prefix: sigil.prefix, label: sigil.label });
    }
  }

  return items;
}
