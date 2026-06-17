// Pure helpers for the composer's slash-command typeahead. Kept DOM-free so they can
// be unit-tested directly: `slashQuery` decides whether the draft is in "command-name"
// mode, `filterCommands` ranks the matches.

import type { CommandInfo } from "@pilot/protocol";

/**
 * The active command-name query, or null when the draft isn't a bare slash token.
 * The menu is for completing the NAME only: a draft is in slash mode when it starts
 * with `/` and has no whitespace yet (the first space means the name is settled and
 * the user is now typing arguments). Returns the text after the leading slash, so
 * `"/rev"` → `"rev"` and `"/"` → `""` (show everything).
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/**
 * Filter + rank commands for a query (the text after the leading slash, no slash).
 * Case-insensitive substring match on the command name; prefix matches rank above
 * interior ones (so `"re"` surfaces `review` before `core-review`), ties broken
 * alphabetically. An empty query returns every command, alphabetical. Descriptions
 * are shown in the menu but intentionally not matched, to keep ranking predictable.
 */
export function filterCommands(
  commands: readonly CommandInfo[],
  query: string,
): CommandInfo[] {
  const q = query.toLowerCase();
  return commands
    .map((c) => ({ c, at: c.name.toLowerCase().indexOf(q) }))
    .filter((s) => s.at !== -1)
    .sort((a, b) => {
      const ap = a.at === 0 ? 0 : 1;
      const bp = b.at === 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.c.name.localeCompare(b.c.name);
    })
    .map((s) => s.c);
}
