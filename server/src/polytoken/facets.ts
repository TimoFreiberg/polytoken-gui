// Parsing facet frontmatter from `polytoken vfs cat polytoken://facets/<file>` output.
//
// A facet file starts with YAML frontmatter delimited by `---` lines:
//
//   ---
//   name: plan
//   polytoken:
//     model: default_model:full
//     tools: [tag!ALL, tag!ALL_MCP]
//     ...
//   ---
//   {{ transclude("polytoken://system_prompts/facet.md") }}
//   ...
//
// `polytoken vfs ls polytoken://facets` returns FILE NAMES (e.g. `plan.md`), but
// the daemon's `POST /facet` API and `active_facet` state field use the frontmatter
// `name` value (e.g. `plan`) — NOT the file name. So `listFacets` must read each
// file and extract the `name` field rather than returning the raw `vfs ls` output.
//
// We only need the single `name` field, so a regex-based extractor suffices (no YAML
// dependency). This follows the project's pattern of custom parsers (parseModels,
// parseSlashCommands, parseFileCatalog) over adding a dependency.

/**
 * Extract the `name` field from a facet file's YAML frontmatter.
 *
 * @returns The name value (trimmed, quotes stripped), or `undefined` if the file
 *   has no frontmatter or no `name` field. The caller falls back to the file stem.
 *
 * Pure — no I/O. Unit-testable without invoking the binary.
 */
export function parseFacetName(content: string): string | undefined {
  // Frontmatter is a leading `---` ... `---` block at the start of the file.
  // `---` must be at the very start (line 1, no leading blank lines), matching the
  // daemon's facet files. The first subsequent line starting with `---` closes the
  // block (standard frontmatter semantics — an unterminated block "closed" by a
  // body horizontal rule is indistinguishable from a real close). We extract the
  // block, then find the `name:` field inside it.
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch?.[1]) return undefined;

  const frontmatter = fmMatch[1];
  // `name:` at the start of a line (no indent — it's a top-level frontmatter key).
  // The value may be quoted ("plan" or 'plan') or unquoted (plan). Capture the
  // raw value, then strip surrounding quotes and trim.
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (!nameMatch?.[1]) return undefined;

  let value = nameMatch[1].trim();
  // Strip a single layer of matching surrounding quotes (single or double).
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}
