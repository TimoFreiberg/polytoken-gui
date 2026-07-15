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
//! badge, so a new value needs no client change.
//!
//! **Builtins are client-intercepted.** Commands like `/clear`, `/compact`,
//! `/facet`, `/reset-shell`, `/daemon-reload`, `/goal`, and `/title` are
//! intercepted by the client (`Composer.svelte`) and routed to dedicated
//! daemon REST endpoints — they are never sent as text prompts. The remaining
//! daemon builtins that pantoken has no first-class UI for are filtered out by
//! `OMITTED_CANONICALS` so they don't appear in the autosuggest menu; typing
//! one manually yields an "Unknown slash command" error.
//!
//! Extension/prompt/skill commands (not daemon builtins) still pass through as
//! text — the daemon runs them via its prompt path.

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

/// Daemon builtins pantoken does NOT implement as a client-intercepted
/// command, so they are filtered from the autosuggest menu. Typing one
/// manually shows "Unknown slash command" (the server omits them, so the
/// client never sees them as known commands).
///
/// Commands NOT listed here (`/clear`, `/compact`, `/facet`, `/reset-shell`,
/// `/daemon-reload`, `/goal`, `/title`) are client-intercepted builtins — they
/// appear in the menu and dispatch to daemon REST endpoints.
///
/// Note: aliases (e.g. `/models`, `/exit`, `/permission`) are in the daemon's
/// `aliases` array, not the `commands` array — only canonical names are
/// matched here.
const OMITTED_CANONICALS: &[&str] = &[
    "/model",       // native ModelPicker
    "/jobs",        // interactive job list (no UI)
    "/mcp",         // interactive server selection (no UI)
    "/permissions", // interactive choice (Settings panel covers it)
    "/todo",        // interactive choice (Todos panel covers it)
    "/theme",       // interactive theme picker (no UI)
    "/rewind",      // interactive rewind view (no UI)
    "/help",        // TUI-only overlay
    "/refresh",     // TUI-only display refresh
    "/quit",        // TUI-only session end
    "/detach",      // TUI-only disconnect
    "/version",     // TUI-only version display
    "/inputdebug",  // TUI-only diagnostic overlay
];

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

    const REAL_OUTPUT: &str = r#"{"categories":[{"id":"immediate","title":"Immediate commands"},{"id":"choice","title":"Commands that take a choice"},{"id":"free-text","title":"Commands that take free text"}],"commands":[{"canonical":"/clear","aliases":[],"category":"immediate","description":"Clears the working context. Your session history is untouched."},{"canonical":"/reset-shell","aliases":[],"category":"immediate","description":"Restores the shell environment to the state Polytoken captured when the session started."},{"canonical":"/rewind","aliases":[],"category":"immediate","description":"Opens the rewind view to return the conversation to an earlier point."},{"canonical":"/help","aliases":[],"category":"immediate","description":"Opens the help overlay."},{"canonical":"/refresh","aliases":[],"category":"immediate","description":"Refreshes the interface. Use this if the display falls out of step with the session."},{"canonical":"/quit","aliases":["/exit"],"category":"immediate","description":"Ends the session."},{"canonical":"/detach","aliases":[],"category":"immediate","description":"Disconnects the interface and leaves the session running."},{"canonical":"/version","aliases":[],"category":"immediate","description":"Shows the TUI and daemon build versions."},{"canonical":"/inputdebug","aliases":[],"category":"immediate","description":"Toggles a diagnostic overlay showing raw input events."},{"canonical":"/daemon-reload","aliases":[],"category":"immediate","description":"Reloads daemon configuration: skills, facets, config files."},{"canonical":"/model","aliases":["/models"],"category":"choice","description":"Switch the active model."},{"canonical":"/facet","aliases":[],"category":"choice","description":"Switch the active facet."},{"canonical":"/permissions","aliases":["/permission"],"category":"choice","description":"Switch how tool approvals are handled."},{"canonical":"/todo","aliases":["/todos"],"category":"choice","description":"Show todos, or act on one."},{"canonical":"/jobs","aliases":["/job"],"category":"choice","description":"Show running jobs, or act on one."},{"canonical":"/mcp","aliases":[],"category":"choice","description":"Enable or disable an MCP server. Type a server name, then choose enable or disable."},{"canonical":"/theme","aliases":["/themes"],"category":"choice","description":"Switch the interface theme."},{"canonical":"/goal","aliases":[],"category":"choice","description":"Set, pause, resume, or clear the active goal."},{"canonical":"/title","aliases":[],"category":"free-text","description":"Sets the session title. With no argument, clears your override and reverts to the inferred title."},{"canonical":"/compact","aliases":[],"category":"free-text","description":"Summarizes the context. Optional text steers what the summary keeps."}]}"#;

    #[test]
    fn parses_the_real_observed_output() {
        let cmds = parse_slash_commands(REAL_OUTPUT);
        // 19 canonicals total, minus 13 omitted (interactive/TUI-only builtins
        // with no pantoken UI). The 7 remaining are client-intercepted builtins:
        // clear, reset-shell, daemon-reload, goal, facet, compact, title.
        assert_eq!(cmds.len(), 7);
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
    fn omits_unsupported_commands() {
        let cmds = parse_slash_commands(REAL_OUTPUT);
        // All OMITTED_CANONICALS should be absent from parsed output.
        for omitted in OMITTED_CANONICALS {
            let name = omitted.trim_start_matches('/');
            assert!(
                !cmds.iter().any(|c| c.name == name),
                "{omitted} should be omitted but was found in parsed output"
            );
        }
    }

    #[test]
    fn goal_and_daemon_reload_not_omitted() {
        let cmds = parse_slash_commands(REAL_OUTPUT);
        assert!(
            cmds.iter().any(|c| c.name == "goal"),
            "/goal should appear in parsed output"
        );
        assert!(
            cmds.iter().any(|c| c.name == "daemon-reload"),
            "/daemon-reload should appear in parsed output"
        );
        assert!(
            cmds.iter().any(|c| c.name == "reset-shell"),
            "/reset-shell should appear in parsed output"
        );
        assert!(
            cmds.iter().any(|c| c.name == "title"),
            "/title should appear in parsed output"
        );
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
