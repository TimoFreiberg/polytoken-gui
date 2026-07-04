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
