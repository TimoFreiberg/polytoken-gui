// Pure helpers for the composer's slash-command typeahead. Kept DOM-free so they can
// be unit-tested directly: `slashQuery` decides whether the draft is in "command-name"
// mode, `filterCommands` ranks the matches.

import type { CommandInfo } from "@pantoken/protocol";

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
 * Parse a submitted draft into a slash command name + args, or null if the
 * draft doesn't start with `/`. Unlike `slashQuery` (which is for the
 * typeahead menu and returns null once a space appears), this is for the
 * submit path: it works on the full draft, extracting the first token after
 * the slash as the command name and the rest as arguments.
 *
 * Uses trimStart() — deliberately divergent from `slashQuery`, which does NOT
 * trim (the typeahead only activates for a clean leading slash, so a draft
 * with leading whitespace never opens the menu). On the submit path, a user
 * may paste with accidental leading whitespace, so trimming is the forgiving
 * choice: `  /clear` is intercepted as `/clear`.
 *
 * Returns `{ name, args }` where `name` is the bare command name (no slash)
 * and `args` is the remaining text after the first space (trimmed), or empty
 * string if no args.
 */
export function parseSlashCommand(
  text: string,
): { name: string; args: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  // No command name (just "/" or "/ foo") → not a command.
  if (rest.length === 0 || /\s/.test(rest.charAt(0))) return null;
  const spaceIdx = rest.search(/\s/);
  if (spaceIdx === -1) return { name: rest, args: "" };
  return { name: rest.slice(0, spaceIdx), args: rest.slice(spaceIdx + 1).trim() };
}

/**
 * The active `/mcp` argument stage, or null when the draft isn't in `/mcp`'s
 * argument position. Returns the stage + the partial being typed:
 *   - `/mcp `           → { stage: "server", partial: "" }
 *   - `/mcp play`       → { stage: "server", partial: "play" }
 *   - `/mcp playwright ` → { stage: "action", partial: "" }
 *   - `/mcp playwright en` → { stage: "action", partial: "en" }
 *   - `/mcp` (no space) → null (name still being typed — the slash menu owns it)
 *   - anything else     → null
 *
 * `mcpArgStage` is pure and stateless — it does NOT know the configured server
 * list, so it returns `stage: "action"` for any `/mcp <name> <partial>`. The
 * Composer gates the action menu on the server name exact-matching a known
 * server (a nonexistent server shows no action candidates).
 *
 * Parsing is cursor-aware (mirrors `extractAtQuery`): the active token is the
 * one containing the cursor. Consecutive whitespace collapses to a single
 * separator (matches `parseSlashCommand`'s trim behavior). Server names are
 * identifiers, so the partial/serverName preserve case; only the command name
 * is matched case-insensitively.
 */
export function mcpArgStage(
  draft: string,
  cursorPos = draft.length,
): { stage: "server" | "action"; partial: string; serverName: string } | null {
  // Must start with "/mcp" (case-insensitive); "/mcpx" does not match.
  if (draft.length < 4 || draft.slice(0, 4).toLowerCase() !== "/mcp") return null;
  // A separating whitespace must follow the command name — without it the name
  // is still being typed and the slash menu owns completion.
  if (draft.length < 5 || !/\s/.test(draft[4]!)) return null;

  const pos = Math.min(cursorPos, draft.length);
  // Cursor still within the command-name token (before the separator) → slash menu.
  if (pos <= 4) return null;

  // Everything after "/mcp" up to the cursor (begins with the separator whitespace).
  const afterCmd = draft.slice(4, pos);
  const endsWithWs = /\s/.test(afterCmd[afterCmd.length - 1] ?? "");
  const tokens = afterCmd.trim().length === 0 ? [] : afterCmd.trim().split(/\s+/);

  if (endsWithWs) {
    // Cursor sits in a fresh (possibly empty) token after `tokens.length` settled
    // tokens. 0 settled → server stage (empty partial); 1 settled → action stage.
    if (tokens.length === 0) return { stage: "server", partial: "", serverName: "" };
    if (tokens.length === 1) return { stage: "action", partial: "", serverName: tokens[0]! };
    // 2+ settled tokens → past the action stage, no further completion.
    return null;
  }
  // Cursor mid-token: the last token is the partial being typed.
  if (tokens.length === 1) return { stage: "server", partial: tokens[0]!, serverName: "" };
  if (tokens.length === 2) return { stage: "action", partial: tokens[1]!, serverName: tokens[0]! };
  return null;
}

/** Rank a list of names against a substring query: prefix matches first, then
 *  interior matches, ties alphabetical. Empty query returns everything. Shared
 *  by the `/mcp` server-name and action typeaheads so ranking matches the slash
 *  command menu's `filterCommands` exactly. */
function filterNames<T>(items: readonly T[], query: string, nameOf: (t: T) => string): T[] {
  const q = query.toLowerCase();
  return items
    .map((it) => ({ it, at: nameOf(it).toLowerCase().indexOf(q) }))
    .filter((s) => s.at !== -1)
    .sort((a, b) => {
      const ap = a.at === 0 ? 0 : 1;
      const bp = b.at === 0 ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return nameOf(a.it).localeCompare(nameOf(b.it));
    })
    .map((s) => s.it);
}

/** The four `/mcp` actions (mirrors `McpAction` / `store.setMcpServer`). */
export interface McpActionItem {
  readonly action: "enable" | "disable" | "disconnect" | "reconnect";
  readonly description: string;
}
const MCP_ACTIONS: readonly McpActionItem[] = [
  { action: "enable", description: "Start the server and its tools" },
  { action: "disable", description: "Stop the server; tools unavailable" },
  { action: "disconnect", description: "Drop the active connection" },
  { action: "reconnect", description: "Re-establish the connection" },
];

/** Filter `/mcp` actions by a partial (empty → all four). */
export function filterMcpActions(partial: string): McpActionItem[] {
  return filterNames(MCP_ACTIONS, partial, (a) => a.action);
}

/** Filter MCP server names by a partial substring (empty → all). */
export function filterMcpServers<T extends { serverName: string }>(
  servers: readonly T[],
  partial: string,
): T[] {
  return filterNames(servers, partial, (s) => s.serverName);
}

/** Filter facet names by a partial substring (empty → all). Facets are plain
 *  strings, so `nameOf` is the identity. Same ranking as the other menus. */
export function filterFacets(facets: readonly string[], partial: string): string[] {
  return filterNames(facets, partial, (f) => f);
}

/** The four `/goal` subcommands (mirrors `dispatchBuiltin`'s goal case). */
export interface GoalSubcommand {
  readonly name: "set" | "clear" | "pause" | "resume";
  readonly description: string;
}
const GOAL_SUBCOMMANDS: readonly GoalSubcommand[] = [
  { name: "set", description: "Set or replace the active goal" },
  { name: "clear", description: "Clear the active goal" },
  { name: "pause", description: "Pause the active goal" },
  { name: "resume", description: "Resume a paused goal" },
];

/** Filter `/goal` subcommands by a partial (empty → all four). */
export function filterGoalSubcommands(partial: string): GoalSubcommand[] {
  return filterNames(GOAL_SUBCOMMANDS, partial, (s) => s.name);
}

/**
 * The active `/facet` argument stage, or null when the draft isn't in `/facet`'s
 * argument position. Single-stage (just the facet name), mirroring the first
 * stage of `mcpArgStage`:
 *   - `/facet `         → { partial: "" }
 *   - `/facet pl`       → { partial: "pl" }
 *   - `/facet` (no space) → null (name still being typed — the slash menu owns it)
 *   - `/facet plan extra` → null (past the single arg stage)
 *   - anything else     → null
 *
 * Cursor-aware (mirrors `mcpArgStage`): the active token is the one containing
 * the cursor. The command name is matched case-insensitively; the partial
 * preserves case (facet names are identifiers).
 */
export function facetArgStage(
  draft: string,
  cursorPos = draft.length,
): { partial: string } | null {
  // Must start with "/facet" (case-insensitive); "/facetx" does not match.
  if (draft.length < 6 || draft.slice(0, 6).toLowerCase() !== "/facet") return null;
  // A separating whitespace must follow the command name — without it the name
  // is still being typed and the slash menu owns completion.
  if (draft.length < 7 || !/\s/.test(draft[6]!)) return null;

  const pos = Math.min(cursorPos, draft.length);
  // Cursor still within the command-name token (before the separator) → slash menu.
  if (pos <= 6) return null;

  // Everything after "/facet" up to the cursor (begins with the separator whitespace).
  const afterCmd = draft.slice(6, pos);
  const endsWithWs = /\s/.test(afterCmd[afterCmd.length - 1] ?? "");
  const tokens = afterCmd.trim().length === 0 ? [] : afterCmd.trim().split(/\s+/);

  if (endsWithWs) {
    // Cursor sits in a fresh (possibly empty) token after `tokens.length` settled
    // tokens. 0 settled → facet stage (empty partial); 1+ settled → past the
    // single arg stage, no further completion.
    if (tokens.length === 0) return { partial: "" };
    return null;
  }
  // Cursor mid-token: the last token is the partial being typed.
  if (tokens.length === 1) return { partial: tokens[0]! };
  // 2+ tokens → past the single arg stage.
  return null;
}

/**
 * The active `/goal` argument stage, or null when the draft isn't in `/goal`'s
 * argument position. Single-stage (the subcommand), but also returns the settled
 * subcommand so the Composer can show a "type the goal text" hint after `/goal set`:
 *   - `/goal `           → { partial: "", subcommand: null } (show subcommand menu)
 *   - `/goal se`         → { partial: "se", subcommand: null } (show subcommand menu, filtered)
 *   - `/goal set `       → { partial: "", subcommand: "set" } (show hint, no menu)
 *   - `/goal set hello`  → { partial: "hello", subcommand: "set" } (show hint, no menu)
 *   - `/goal pause `     → { partial: "", subcommand: "pause" } (no menu, no hint — Enter dispatches)
 *   - `/goal pause extra` → { partial: "extra", subcommand: "pause" } (still in text mode — parser is structural)
 *   - `/goal` (no space) → null (name still being typed — the slash menu owns it)
 *   - anything else      → null
 *
 * `subcommand` is the raw first token (any string, or null when still in the
 * subcommand-typing stage). It is NOT narrowed to the four valid subcommand
 * names — e.g. `/goal bogus ` returns `{ partial: "", subcommand: "bogus" }`.
 * The Composer's `goalSetHint` derived only activates when `subcommand === "set"`
 * exactly; all other values produce no menu and no hint, and Enter falls through
 * to `dispatchBuiltin` which handles valid/invalid subcommands. The parser is
 * purely structural.
 *
 * Cursor-aware (mirrors `mcpArgStage`).
 */
export function goalArgStage(
  draft: string,
  cursorPos = draft.length,
): { partial: string; subcommand: string | null } | null {
  // Must start with "/goal" (case-insensitive); "/goalx" does not match.
  if (draft.length < 5 || draft.slice(0, 5).toLowerCase() !== "/goal") return null;
  // A separating whitespace must follow the command name — without it the name
  // is still being typed and the slash menu owns completion.
  if (draft.length < 6 || !/\s/.test(draft[5]!)) return null;

  const pos = Math.min(cursorPos, draft.length);
  // Cursor still within the command-name token (before the separator) → slash menu.
  if (pos <= 5) return null;

  // Everything after "/goal" up to the cursor (begins with the separator whitespace).
  const afterCmd = draft.slice(5, pos);
  const endsWithWs = /\s/.test(afterCmd[afterCmd.length - 1] ?? "");
  const tokens = afterCmd.trim().length === 0 ? [] : afterCmd.trim().split(/\s+/);

  if (endsWithWs) {
    // Cursor sits in a fresh (possibly empty) token after `tokens.length` settled
    // tokens. 0 settled → subcommand stage (empty partial, no subcommand yet);
    // 1+ settled → subcommand is settled. We never return null for 2+ tokens
    // because `set` takes multi-word free-form text — the parser is purely
    // structural and can't distinguish `set` (takes args) from `pause` (no args).
    // The Composer's deriveds gate the menu on `subcommand === null` and the
    // hint on `subcommand === "set"`; other settled subcommands produce no menu
    // and no hint, and Enter falls through to dispatchBuiltin.
    if (tokens.length === 0) return { partial: "", subcommand: null };
    return { partial: "", subcommand: tokens[0]! };
  }
  // Cursor mid-token: the last token is the partial being typed.
  if (tokens.length === 1) return { partial: tokens[0]!, subcommand: null };
  return { partial: tokens[tokens.length - 1]!, subcommand: tokens[0]! };
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
