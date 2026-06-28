// Unit tests for parseFileCatalog — pure, no daemon. Fixtures use the GET /files
// shape documented in the OpenAPI FileCatalogResponse (spike §8).

import { test, expect } from "bun:test";
import { parseFileCatalog } from "./file-catalog.js";

test("parseFileCatalog > splits files from dirs by trailing slash", () => {
  const out = parseFileCatalog(["src/main.ts", "src/lib/", "README.md", "docs/"]);
  expect(out).toEqual([
    { path: "src/main.ts", isDirectory: false },
    { path: "src/lib", isDirectory: true },
    { path: "README.md", isDirectory: false },
    { path: "docs", isDirectory: true },
  ]);
});

test("parseFileCatalog > drops stray .git entries defensively", () => {
  const out = parseFileCatalog([".git", ".git/config", "src/.git/hooks", "src/main.ts"]);
  expect(out).toEqual([{ path: "src/main.ts", isDirectory: false }]);
});

test("parseFileCatalog > empty input yields []", () => {
  expect(parseFileCatalog([])).toEqual([]);
});

test("parseFileCatalog > non-string and empty entries are skipped", () => {
  expect(parseFileCatalog(["", "valid.ts"])).toEqual([
    { path: "valid.ts", isDirectory: false },
  ]);
});

test("parseFileCatalog > a root-level directory with trailing slash", () => {
  const out = parseFileCatalog(["node_modules/"]);
  expect(out).toEqual([{ path: "node_modules", isDirectory: true }]);
});
