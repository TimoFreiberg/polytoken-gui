//! Parsing `polytoken print-slash-commands --format json` into pantoken's
//! `CommandInfo[]`.
//!
//! Port of `server/src/polytoken/commands.ts`.
//!
//! The JSON shape (observed):
//!
//! ```json
//! { "categories": [{ "id": "immediate", "title": "Immediate commands" }, ...],
//!   "commands": [
//!     { "canonical": "/clear", "aliases": [], "category": "immediate",
//!       "description": "Clears the working context. ..." },
//!     ...
//!   ] }
//! ```
//!
//! polytoken's commands are all daemon builtins. pantoken's `CommandInfo.source`
//! union gains `"builtin"` for them; the client renders `source` as a string
//! badge, so a new value needs no client change. Sending `/name args` as a
//! normal prompt routes through polytoken's prompt path, which runs the builtin
//! — exactly how the daemon's extension commands work.
//!
//! TUI builtins like /model + /models are deliberately omitted because pantoken
//! has native UI for those (ModelPicker drives POST /model). The rest (/compact,
//! /rewind, /facet, /permissions, /title, /clear, …) have no first-class pantoken
//! affordance OR are useful as quick-access text shortcuts, so they surface in
//! the slash menu.

use pantoken_protocol::session_driver::{CommandInfo, CommandSource};
use serde::Deserialize;

/// One slash command from `polytoken print-slash-commands`. The shape is the
/// raw JSON the daemon prints; we keep it loose (extra fields ignored) so a
/// future daemon adding a field can't crash the parser.
#[derive(Debug, Clone, Deserialize)]
struct RawCommand {
    canonical: String,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "daemon slash-command aliases are parsed but not surfaced until command-menu parity work"
    )]
    aliases: Option<Vec<String>>,
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "daemon slash-command categories are parsed but not surfaced until command-menu parity work"
    )]
    category: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

/// The raw top-level JSON shape from `polytoken print-slash-commands --format json`.
#[derive(Debug, Clone, Deserialize)]
struct RawSlashCommands {
    #[serde(default)]
    #[expect(
        dead_code,
        reason = "daemon command categories are parsed but not displayed until command-menu parity work"
    )]
    categories: Option<Vec<RawCategory>>,
    #[serde(default)]
    commands: Option<Vec<RawCommand>>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawCategory {
    #[expect(
        dead_code,
        reason = "daemon command category metadata is parsed but not displayed until command-menu parity work"
    )]
    id: String,
    #[expect(
        dead_code,
        reason = "daemon command category metadata is parsed but not displayed until command-menu parity work"
    )]
    title: String,
}

/// Commands pantoken has a native first-class UI for, so they don't need a
/// slash-menu duplicate (pantoken's affordance is richer than a text command).
/// Mirrors the original driver's omission of TUI builtins. `/model` + `/models`
/// both drive the ModelPicker.
const OMITTED_CANONICALS: &[&str] = &["/model", "/models"];

/// Parse `polytoken print-slash-commands --format json` stdout into
/// `CommandInfo[]`. Pure — no I/O. Loud on non-JSON input: a parse failure
/// returns `[]` (a malformed dump shouldn't blank the whole menu — the worst
/// case is an empty menu, which is honest).
pub fn parse_slash_commands(stdout: &str) -> Vec<CommandInfo> {
    let parsed: RawSlashCommands = match serde_json::from_str(stdout) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let Some(commands) = parsed.commands else {
        return Vec::new();
    };
    let mut out: Vec<CommandInfo> = Vec::new();
    for cmd in commands {
        // Skip empty canonicals.
        if cmd.canonical.is_empty() {
            continue;
        }
        if OMITTED_CANONICALS.contains(&cmd.canonical.as_str()) {
            continue;
        }
        // Strip the leading slash — pantoken's typeahead matches on the bare name
        // and re-adds the slash on insertion (see SlashMenu).
        let name = cmd.canonical.trim_start_matches('/').to_string();
        if name.is_empty() {
            continue;
        }
        out.push(CommandInfo {
            name,
            description: cmd.description,
            source: CommandSource::Builtin,
            argument_hint: None,
        });
    }
    out
}
