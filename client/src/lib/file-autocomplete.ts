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

/**
 * Rank the prefetched file index against an @-mention query, for instant client-side
 * matching. Case-insensitive substring match on the path (consistent with the slash-command
 * filter and the agent's TUI autocomplete); a query is dropped if it isn't a substring of the path.
 *
 * Ranking, best first:
 *   1. query matches the start of the basename (the file/dir name itself) — `hub` → `…/hub.ts`
 *   2. query matches the start of the full path — `server` → `server/src/…`
 *   3. query matches anywhere else in the path
 * Ties break by directory-before-file (so a dir the user can keep narrowing surfaces first,
 * per the driver's documented ordering), then shorter path, then alphabetical.
 *
 * An empty query returns the head of the index (it's already in fd's order) — the bare-`@`
 * list. Results are capped at `limit`.
 */
export function filterFiles(
  files: readonly FileInfo[],
  query: string,
  limit = 50,
): FileInfo[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();

  const scored: { f: FileInfo; rank: number; len: number }[] = [];
  for (const f of files) {
    const path = f.path.toLowerCase();
    const at = path.indexOf(q);
    if (at === -1) continue;
    const slash = path.lastIndexOf("/");
    const basenameStart = slash + 1; // 0 when no slash
    const rank = at === basenameStart ? 0 : at === 0 ? 1 : 2;
    scored.push({ f, rank, len: path.length });
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.f.isDirectory !== b.f.isDirectory) return a.f.isDirectory ? -1 : 1;
    if (a.len !== b.len) return a.len - b.len;
    return a.f.path.localeCompare(b.f.path);
  });

  return scored.slice(0, limit).map((s) => s.f);
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
    // the current query (the caller already filters `serverFiles` to the current
    // query via the `store.files.query === atQ` echo guard).
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
