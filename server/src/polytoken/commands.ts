// Parsing `polytoken print-slash-commands --format json` into pilot's
// `CommandInfo[]`.
//
// The JSON shape (observed):
//
//   { "categories": [{ "id": "immediate", "title": "Immediate commands" }, ...],
//     "commands": [
//       { "canonical": "/clear", "aliases": [], "category": "immediate",
//         "description": "Clears the working context. ..." },
//       ...
//     ] }
//
// polytoken's commands are all daemon builtins. pilot's `CommandInfo.source` union
// gains `"builtin"` for them; the client renders `source` as a string badge, so a new
// value needs no client change. Sending `/name args` as a normal prompt routes through
// polytoken's prompt path, which runs the builtin — exactly how the daemon's extension
// commands work.
//
// TUI builtins like /model + /models are deliberately omitted because pilot has native
// UI for those (ModelPicker drives POST /model). The rest (/compact, /rewind, /facet,
// /permissions, /title, /clear, …) have no first-class pilot affordance OR are
// useful as quick-access text shortcuts, so they surface in the slash menu.

import type { CommandInfo } from "@pilot/protocol";

/** One slash command from `polytoken print-slash-commands`. The shape is the raw
 *  JSON the daemon prints; we keep it loose (extra fields ignored) so a future
 *  daemon adding a field can't crash the parser. */
interface RawCommand {
  canonical: string;
  aliases?: string[];
  category?: string;
  description?: string;
}

/** The raw top-level JSON shape from `polytoken print-slash-commands --format json`. */
interface RawSlashCommands {
  categories?: { id: string; title: string }[];
  commands?: RawCommand[];
}

/** Commands pilot has a native first-class UI for, so they don't need a slash-menu
 *  duplicate (pilot's affordance is richer than a text command). Mirrors the original driver's
 *  omission of TUI builtins. `/model` + `/models` both drive the ModelPicker. */
const OMITTED_CANONICALS = new Set(["/model", "/models"]);

/** Parse `polytoken print-slash-commands --format json` stdout into `CommandInfo[]`.
 *  Pure — no I/O. Loud on non-JSON input: a parse failure returns [] (a malformed
 *  dump shouldn't blank the whole menu — the worst case is an empty menu, which is
 *  honest). */
export function parseSlashCommands(stdout: string): CommandInfo[] {
  let parsed: RawSlashCommands;
  try {
    parsed = JSON.parse(stdout) as RawSlashCommands;
  } catch {
    return [];
  }
  const commands = parsed.commands;
  if (!Array.isArray(commands)) return [];
  const out: CommandInfo[] = [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd.canonical !== "string") continue;
    if (OMITTED_CANONICALS.has(cmd.canonical)) continue;
    // Strip the leading slash — pilot's typeahead matches on the bare name and
    // re-adds the slash on insertion (see SlashMenu).
    const name = cmd.canonical.replace(/^\/+/, "");
    if (!name) continue;
    out.push({
      name,
      description: cmd.description,
      source: "builtin",
    });
  }
  return out;
}
