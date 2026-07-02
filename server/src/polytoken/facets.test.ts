// Unit tests for parseFacetName — pure, no binary invocation. Fixtures are the real
// facet file shapes (observed via `polytoken vfs cat polytoken://facets/plan.md`).

import { test, expect } from "bun:test";
import { parseFacetName } from "./facets.js";

// The actual observed frontmatter from `polytoken vfs cat polytoken://facets/plan.md`
// (polytoken 0.4.x). The `name` field is lowercase, matching the file stem.
const REAL_PLAN_FACET = `---
name: plan
polytoken:
  model: default_model:full
  tools: [tag!ALL, tag!ALL_MCP]
  tools_deny: [file_write, file_edit_search_replace, file_edit_hashline, patch_edit, shell_exec, shell_monitor, switch_facet]
  autonomous_hint: "This facet is read-only; the agent is in a planning phase and should not be performing destructive shell operations."
  color_light: "#005f91"
  color_dark: "#64beff"
  undeferred_tools: [file_read, write_plan, edit_plan, handoff_plan, subagent, job_status, job_result, job_cancel, job_block, web_search, web_fetch]
---
{{ transclude("polytoken://system_prompts/facet.md") }}

You are in plan facet. This is a read-only planning and investigation mode.
`;

test("parseFacetName > extracts the name from the real plan facet frontmatter", () => {
  expect(parseFacetName(REAL_PLAN_FACET)).toBe("plan");
});

test("parseFacetName > extracts an unquoted name value", () => {
  const content = "---\nname: Plan\nother: value\n---\nbody text\n";
  expect(parseFacetName(content)).toBe("Plan");
});

test("parseFacetName > strips surrounding double quotes", () => {
  const content = '---\nname: "Plan"\n---\nbody\n';
  expect(parseFacetName(content)).toBe("Plan");
});

test("parseFacetName > strips surrounding single quotes", () => {
  const content = "---\nname: 'Plan'\n---\nbody\n";
  expect(parseFacetName(content)).toBe("Plan");
});

test("parseFacetName > returns undefined for no frontmatter", () => {
  const content =
    "Just some markdown content with no frontmatter.\n\n# Heading\n";
  expect(parseFacetName(content)).toBeUndefined();
});

test("parseFacetName > returns undefined for frontmatter without a name field", () => {
  const content =
    "---\ntitle: Something Else\npolytoken:\n  model: foo\n---\nbody\n";
  expect(parseFacetName(content)).toBeUndefined();
});

test("parseFacetName > finds name when other fields precede it", () => {
  const content =
    "---\ntitle: A Title\ndescription: A facet\nname: review\n---\nbody\n";
  expect(parseFacetName(content)).toBe("review");
});

test("parseFacetName > does not match indented name: inside a nested block", () => {
  // The `name:` under `polytoken:` is indented — a nested key, not the top-level
  // facet name. The top-level `name:` field is what we want.
  const content =
    "---\nname: execute\npolytoken:\n  name: inner_thing\n---\nbody\n";
  expect(parseFacetName(content)).toBe("execute");
});

test("parseFacetName > handles CRLF line endings", () => {
  const content = "---\r\nname: plan\r\n---\r\nbody\r\n";
  expect(parseFacetName(content)).toBe("plan");
});

test("parseFacetName > returns undefined for unterminated frontmatter", () => {
  // Malformed: the opening --- is never closed. The parser must not treat the
  // rest of the file as frontmatter — the caller falls back to the file stem.
  const content = "---\nname: plan\nno closing delimiter, body runs on\n";
  expect(parseFacetName(content)).toBeUndefined();
});

test("parseFacetName > closing --- must start its own line", () => {
  const content = "---\nname: plan\ntrailing text --- not a delimiter\n";
  expect(parseFacetName(content)).toBeUndefined();
});

test("parseFacetName > returns undefined for empty string", () => {
  expect(parseFacetName("")).toBeUndefined();
});
