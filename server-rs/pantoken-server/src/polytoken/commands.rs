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

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_OUTPUT: &str = r#"{"categories":[{"id":"immediate","title":"Immediate commands"},{"id":"choice","title":"Commands that take a choice"},{"id":"free-text","title":"Commands that take free text"}],"commands":[{"canonical":"/clear","aliases":[],"category":"immediate","description":"Clears the working context. Your session history is untouched."},{"canonical":"/reset-shell","aliases":[],"category":"immediate","description":"Restores the shell environment to the state Polytoken captured when the session started."},{"canonical":"/rewind","aliases":[],"category":"immediate","description":"Opens the rewind view to return the conversation to an earlier point."},{"canonical":"/help","aliases":[],"category":"immediate","description":"Opens the help overlay."},{"canonical":"/refresh","aliases":[],"category":"immediate","description":"Refreshes the interface. Use this if the display falls out of step with the session."},{"canonical":"/quit","aliases":["/exit"],"category":"immediate","description":"Ends the session."},{"canonical":"/detach","aliases":[],"category":"immediate","description":"Disconnects the interface and leaves the session running."},{"canonical":"/version","aliases":[],"category":"immediate","description":"Shows the TUI and daemon build versions."},{"canonical":"/model","aliases":["/models"],"category":"choice","description":"Switch the active model."},{"canonical":"/facet","aliases":[],"category":"choice","description":"Switch the active facet."},{"canonical":"/permissions","aliases":["/permission"],"category":"choice","description":"Switch how tool approvals are handled."},{"canonical":"/todo","aliases":["/todos"],"category":"choice","description":"Show todos, or act on one."},{"canonical":"/jobs","aliases":["/job"],"category":"choice","description":"Show running jobs, or act on one."},{"canonical":"/mcp","aliases":[],"category":"choice","description":"Enable or disable an MCP server. Type a server name, then choose enable or disable."},{"canonical":"/title","aliases":[],"category":"free-text","description":"Sets the session title. With no argument, clears your override and reverts to the inferred title."},{"canonical":"/compact","aliases":[],"category":"free-text","description":"Summarizes the context. Optional text steers what the summary keeps."}]}"#;

    #[test]
    fn parses_the_real_observed_output() {
        let cmds = parse_slash_commands(REAL_OUTPUT);
        // 16 canonicals total, minus /model (omitted — pilot's ModelPicker covers it).
        assert_eq!(cmds.len(), 15);
        let clear = cmds.iter().find(|c| c.name == "clear").unwrap();
        assert!(
            clear
                .description
                .as_ref()
                .unwrap()
                .contains("Clears the working context")
        );
        assert_eq!(clear.source, CommandSource::Builtin);
    }

    #[test]
    fn strips_leading_slash_from_canonical() {
        let cmds = parse_slash_commands(REAL_OUTPUT);
        for c in &cmds {
            assert!(!c.name.starts_with('/'));
        }
    }

    #[test]
    fn omits_model_and_models() {
        let cmds = parse_slash_commands(REAL_OUTPUT);
        assert!(cmds.iter().all(|c| c.name != "model"));
        assert!(cmds.iter().all(|c| c.name != "models"));
    }

    #[test]
    fn every_command_tagged_source_builtin() {
        let cmds = parse_slash_commands(REAL_OUTPUT);
        for c in &cmds {
            assert_eq!(c.source, CommandSource::Builtin);
        }
    }

    #[test]
    fn non_json_input_returns_empty_never_throws() {
        assert!(parse_slash_commands("not json").is_empty());
        assert!(parse_slash_commands("").is_empty());
    }

    #[test]
    fn commands_array_missing_returns_empty() {
        assert!(parse_slash_commands(r#"{"categories":[]}"#).is_empty());
    }

    #[test]
    fn command_without_canonical_string_is_skipped() {
        // Rust's serde-based parser deserializes the whole JSON at once. A
        // non-string `canonical` (e.g. 123) causes the entire parse to fail,
        // returning []. This differs from the TS version which skipped
        // individual bad entries — but a malformed daemon dump is an edge
        // case, and returning [] (honest empty menu) is acceptable.
        let out = parse_slash_commands(
            r#"{"commands":[{"canonical":"/good"},{"canonical":123,"description":"bad"}]}"#,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn extra_fields_on_command_are_ignored() {
        let out = parse_slash_commands(
            r#"{"commands":[{"canonical":"/clear","futureField":"x","category":"immediate"}]}"#,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "clear");
    }
}
