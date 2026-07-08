// Pure helpers for the composer's @-file mention typeahead. Kept DOM-free so they
// can be unit-tested directly: `extractAtQuery` decides whether the cursor is inside
// a `@`-prefix token and returns the query text + the `@` position for replacement;
// `filterFiles` ranks the prefetched file index against a query for instant local
// matching (no server round-trip).

import type { FileInfo } from "@pantoken/protocol";

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
