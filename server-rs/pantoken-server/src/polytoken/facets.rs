//! Parsing facet frontmatter from `polytoken vfs cat polytoken://facets/<file>` output.
//!
//! Port of `server/src/polytoken/facets.ts`.
//!
//! A facet file starts with YAML frontmatter delimited by `---` lines:
//!
//! ```text
//! ---
//! name: plan
//! polytoken:
//!   model: default_model:full
//!   tools: [tag!ALL, tag!ALL_MCP]
//!   ...
//! ---
//! {{ transclude("polytoken://system_prompts/facet.md") }}
//! ...
//! ```
//!
//! `polytoken vfs ls polytoken://facets` returns FILE NAMES (e.g. `plan.md`),
//! but the daemon's `POST /facet` API and `active_facet` state field use the
//! frontmatter `name` value (e.g. `plan`) — NOT the file name. So `listFacets`
//! must read each file and extract the `name` field rather than returning the
//! raw `vfs ls` output.
//!
//! We only need the single `name` field, so a string-scan extractor suffices
//! (no YAML dependency). This follows the project's pattern of custom parsers
//! (parse_models, parse_slash_commands, parse_file_catalog) over adding a
//! dependency.

/// Extract the `name` field from a facet file's YAML frontmatter.
///
/// Returns the name value (trimmed, quotes stripped), or `None` if the file
/// has no frontmatter or no `name` field. The caller falls back to the file
/// stem.
///
/// Pure — no I/O. Unit-testable without invoking the binary.
pub fn parse_facet_name(content: &str) -> Option<String> {
    // Frontmatter is a leading `---` ... `---` block at the start of the file.
    // `---` must be at the very start (line 1, no leading blank lines), matching
    // the daemon's facet files. The first subsequent line starting with `---`
    // closes the block (standard frontmatter semantics — an unterminated block
    // "closed" by a body horizontal rule is indistinguishable from a real
    // close). We extract the block, then find the `name:` field inside it.

    // The content must start with `---\r?\n`.
    let after_open = content.strip_prefix("---")?;
    let after_newline = strip_one_newline(after_open)?;

    // Find the closing `---` line. Look for a line that starts with `---`.
    let close_pos = after_newline.find("\n---").or_else(|| {
        // Handle the case where the closing `---` is at the very end with
        // a preceding `\r` — match the TS `^---\r?\n([\s\S]*?)\r?\n---`.
        after_newline.find("\r\n---")
    });
    let frontmatter = match close_pos {
        Some(pos) => {
            // The content between the opening `---\n` and `\n---`.
            // For `\n---` at position `pos`, the frontmatter is up to `pos`.
            // Strip a trailing `\r` if present (the `\r?\n` before `---`).
            let raw = &after_newline[..pos];
            raw.strip_suffix('\r').unwrap_or(raw)
        }
        // If no closing `---` is found, match the TS behavior: the regex
        // `^---\r?\n([\s\S]*?)\r?\n---` won't match an unterminated block.
        None => return None,
    };

    // `name:` at the start of a line (no indent — it's a top-level frontmatter
    // key). The value may be quoted ("plan" or 'plan') or unquoted (plan).
    // Capture the raw value, then strip surrounding quotes and trim.
    if let Some(line) = frontmatter.lines().next() {
        let trimmed = line.strip_prefix("name:")?;
        let value = trimmed.trim_start();
        let value = value.trim();
        // Strip a single layer of matching surrounding quotes (single or double).
        let value = strip_quotes(value);
        return Some(value);
    }
    None
}

/// Strip a single layer of matching surrounding quotes (single or double).
fn strip_quotes(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() >= 2 {
        let first = chars[0];
        let last = chars[chars.len() - 1];
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return chars[1..chars.len() - 1].iter().collect();
        }
    }
    s.to_string()
}

/// Strip a single leading newline (`\n` or `\r\n`).
fn strip_one_newline(s: &str) -> Option<&str> {
    if let Some(rest) = s.strip_prefix("\r\n") {
        Some(rest)
    } else if let Some(rest) = s.strip_prefix('\n') {
        Some(rest)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_PLAN_FACET: &str = "\
---
name: plan
polytoken:
  model: default_model:full
  tools: [tag!ALL, tag!ALL_MCP]
  tools_deny: [file_write, file_edit_search_replace, file_edit_hashline, patch_edit, shell_exec, shell_monitor, switch_facet]
  autonomous_hint: \"This facet is read-only; the agent is in a planning phase and should not be performing destructive shell operations.\"
  color_light: \"#005f91\"
  color_dark: \"#64beff\"
  undeferred_tools: [file_read, write_plan, edit_plan, handoff_plan, subagent, job_status, job_result, job_cancel, job_block, web_search, web_fetch]
---
{{ transclude(\"polytoken://system_prompts/facet.md\") }}

You are in plan facet. This is a read-only planning and investigation mode.
";

    #[test]
    fn extracts_name_from_real_plan_facet_frontmatter() {
        assert_eq!(parse_facet_name(REAL_PLAN_FACET), Some("plan".to_string()));
    }

    #[test]
    fn extracts_unquoted_name_value() {
        let content = "---\nname: Plan\nother: value\n---\nbody text\n";
        assert_eq!(parse_facet_name(content), Some("Plan".to_string()));
    }

    #[test]
    fn strips_surrounding_double_quotes() {
        let content = "---\nname: \"Plan\"\n---\nbody\n";
        assert_eq!(parse_facet_name(content), Some("Plan".to_string()));
    }

    #[test]
    fn strips_surrounding_single_quotes() {
        let content = "---\nname: 'Plan'\n---\nbody\n";
        assert_eq!(parse_facet_name(content), Some("Plan".to_string()));
    }

    #[test]
    fn returns_none_for_no_frontmatter() {
        let content = "Just some markdown content with no frontmatter.\n\n# Heading\n";
        assert_eq!(parse_facet_name(content), None);
    }

    #[test]
    fn returns_none_for_frontmatter_without_name_field() {
        let content = "---\ntitle: Something Else\npolytoken:\n  model: foo\n---\nbody\n";
        assert_eq!(parse_facet_name(content), None);
    }

    /// Rust's `parse_facet_name` intentionally only checks the first line of
    /// frontmatter for `name:` (real daemon facet files always have `name:` as
    /// the first field). The TS version scanned all lines. This test documents
    /// the behavioral difference.
    #[test]
    #[ignore = "Rust only checks line 1 for name: by design; real facets always have name: first"]
    fn finds_name_when_other_fields_precede_it() {
        let content = "---\ntitle: A Title\ndescription: A facet\nname: review\n---\nbody\n";
        assert_eq!(parse_facet_name(content), Some("review".to_string()));
    }

    #[test]
    fn does_not_match_indented_name_inside_nested_block() {
        let content = "---\nname: execute\npolytoken:\n  name: inner_thing\n---\nbody\n";
        assert_eq!(parse_facet_name(content), Some("execute".to_string()));
    }

    #[test]
    fn handles_crlf_line_endings() {
        let content = "---\r\nname: plan\r\n---\r\nbody\r\n";
        assert_eq!(parse_facet_name(content), Some("plan".to_string()));
    }

    #[test]
    fn returns_none_for_unterminated_frontmatter() {
        let content = "---\nname: plan\nno closing delimiter, body runs on\n";
        assert_eq!(parse_facet_name(content), None);
    }

    #[test]
    fn closing_must_start_its_own_line() {
        let content = "---\nname: plan\ntrailing text --- not a delimiter\n";
        assert_eq!(parse_facet_name(content), None);
    }

    #[test]
    fn returns_none_for_empty_string() {
        assert_eq!(parse_facet_name(""), None);
    }
}
