// buildSessionMcpConfigOverride is the pi-mcp-adapter cwd workaround: it rewrites a
// per-session copy of <agentDir>/mcp.json with cwd injected into each stdio server.
// Untested — pi-driver.ts calls it but asserts nothing about its decision logic (which
// servers get injected, when to skip, the deterministic temp path). A regression (injecting
// into url servers, clobbering an explicit cwd, non-deterministic path) would silently
// break MCP server spawn dirs. agentDir is a param (tmpdir-injectable); the output file
// lands in os.tmpdir()/pilot-mcp-config, also writable in tests.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildSessionMcpConfigOverride } from "./mcp-cwd-workaround.js";

const TMP = join(tmpdir(), "pilot-mcp-config");

describe("buildSessionMcpConfigOverride", () => {
  let agentDir: string;
  // Each test gets a fresh agentDir so the source mcp.json never leaks; the output
  // dir (os.tmpdir()/pilot-mcp-config) is shared + content-addressed by cwd, so we
  // don't tear it down (concurrent tests / other processes may use it).

  function writeSource(json: unknown): string {
    agentDir = mkdtempSync(join(tmpdir(), "pilot-mcp-override-"));
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(json));
    return agentDir;
  }

  afterEach(() => {
    if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  });

  test("no source mcp.json → undefined (nothing to override)", () => {
    const empty = mkdtempSync(join(tmpdir(), "pilot-mcp-empty-"));
    expect(buildSessionMcpConfigOverride(empty, "/session")).toBeUndefined();
    rmSync(empty, { recursive: true, force: true });
  });

  test("malformed JSON → undefined (let pi surface the error, don't override)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pilot-mcp-bad-"));
    writeFileSync(join(dir, "mcp.json"), "{ not json");
    expect(buildSessionMcpConfigOverride(dir, "/session")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("mcpServers present but no stdio (command) servers → undefined", () => {
    // url-only servers don't spawn a process / write relative to cwd, so there's
    // nothing to inject. Skipping (returning undefined) avoids a pointless temp file.
    const dir = writeSource({
      mcpServers: { browser: { url: "http://localhost:1234/sse" } },
    });
    expect(buildSessionMcpConfigOverride(dir, "/session")).toBeUndefined();
  });

  test("injects cwd into stdio (command) servers without an explicit cwd", () => {
    const dir = writeSource({
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp"] },
        browser: { url: "http://x/sse" }, // url server: untouched
      },
    });
    const out = buildSessionMcpConfigOverride(dir, "/session/cwd");
    expect(out).toBeDefined();
    const written = JSON.parse(readFileSync(out!, "utf8"));
    expect(written.mcpServers.playwright.cwd).toBe("/session/cwd");
    // url server untouched (no cwd key added)
    expect(written.mcpServers.browser.cwd).toBeUndefined();
    expect(written.mcpServers.browser.url).toBe("http://x/sse");
  });

  test("respects an explicit cwd already in config (doesn't clobber)", () => {
    // A server the operator pointed at a specific dir keeps it — the workaround is
    // only for servers that would otherwise inherit the wrong (host process) cwd.
    const dir = writeSource({
      mcpServers: {
        custom: { command: "run.sh", cwd: "/explicit" },
        auto: { command: "npx", args: ["x"] },
      },
    });
    const out = buildSessionMcpConfigOverride(dir, "/session");
    const written = JSON.parse(readFileSync(out!, "utf8"));
    expect(written.mcpServers.custom.cwd).toBe("/explicit"); // preserved
    expect(written.mcpServers.auto.cwd).toBe("/session"); // injected
  });

  test("the output path is deterministic per cwd (content-addressed)", () => {
    // Same cwd → same temp path (the sha1(cwd) key), so a re-warm of the same session
    // reuses the file rather than littering tmpdir. Different cwd → different path.
    const dir = writeSource({
      mcpServers: { s: { command: "c" } },
    });
    const a = buildSessionMcpConfigOverride(dir, "/session/one");
    const b = buildSessionMcpConfigOverride(dir, "/session/one");
    const c = buildSessionMcpConfigOverride(dir, "/session/two");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const expectedKey = createHash("sha1")
      .update("/session/one")
      .digest("hex")
      .slice(0, 16);
    expect(a).toBe(join(TMP, `${expectedKey}.json`));
  });

  test("the generated config preserves non-mcpServers top-level keys", () => {
    // mcp.json may carry other config (e.g. a version/$schema); the rewrite must not
    // drop them — it's a copy with cwd injected, not a projection.
    const dir = writeSource({
      $schema: "https://example.com/mcp.json",
      mcpServers: { s: { command: "c" } },
    });
    const out = buildSessionMcpConfigOverride(dir, "/session");
    const written = JSON.parse(readFileSync(out!, "utf8"));
    expect(written.$schema).toBe("https://example.com/mcp.json");
    expect(written.mcpServers.s.cwd).toBe("/session");
  });
});
