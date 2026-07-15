import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const justfile = readFileSync("justfile", "utf8");
const wrapper = readFileSync("scripts/implement-issue.sh", "utf8");
const readme = readFileSync("scripts/README.md", "utf8");

test("launcher, wrapper, and documentation contracts stay aligned", () => {
  expect(justfile).toContain("bun run scripts/implement-issue.ts {{args}}");
  expect(wrapper.trim()).toBe("#!/usr/bin/env bash\nset -euo pipefail\nexec bun run scripts/implement-issue.ts \"$@\"");
  expect(wrapper).not.toMatch(/awk|grep|curl|seed-prompt|image/i);
  expect(readme).toContain("implement-issue.ts");
  expect(readme).toContain("--dry-run");
  expect(readme).toContain("clarification phase");
  expect(readme).toContain("merge and push");
  expect(readme).toContain("Exit codes: 0=success, 2=conflicts, 1=error");
});
