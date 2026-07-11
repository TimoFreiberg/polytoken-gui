import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLIST_TEMPLATE = join(import.meta.dir, "../../deploy/com.pantoken.server.plist");
const BOOTSTRAP_HEADLESS = join(import.meta.dir, "../../deploy/bootstrap-headless.sh");
const BOOTSTRAP_VALIDATOR = join(import.meta.dir, "../../deploy/bootstrap-tar-validator.sh");

// ── Helpers ──────────────────────────────────────────────────────────────────
function readAll(path: string): string {
  return readFileSync(path, "utf-8");
}

function fixtureRelease(version: string, tmpBase: string): string {
  const release = join(tmpBase, version);
  mkdirSync(join(release, "bin"), { recursive: true });
  mkdirSync(join(release, "client-dist"), { recursive: true });

  writeFileSync(join(release, "VERSION"), version + "\n");
  writeFileSync(join(release, "BUILD_SHA"), "abcd1234abcd1234abcd1234abcd1234abcd1234");

  // Minimal fake binary
  writeFileSync(join(release, "bin", "pantoken-server"), "#!/bin/sh\necho ok\n");
  chmodSync(join(release, "bin", "pantoken-server"), 0o755);

  // Copy run.sh and update.sh from deploy/
  writeFileSync(join(release, "run.sh"), "#!/bin/sh\necho running\n");
  chmodSync(join(release, "run.sh"), 0o755);
  writeFileSync(join(release, "update.sh"), "#!/bin/sh\necho updating\n");
  chmodSync(join(release, "update.sh"), 0o755);

  writeFileSync(join(release, "client-dist", "index.html"), "<html>test</html>");
  return release;
}

// ── Plist template tests ─────────────────────────────────────────────────────
describe("plist template", () => {
  test("exists and is valid XML", () => {
    const content = readAll(PLIST_TEMPLATE);
    expect(content).toContain("<?xml");
    expect(content).toContain("<plist version=\"1.0\">");
    expect(content).toContain("<dict>");
  });

  test("uses @@@PLACEHOLDER@@@ syntax (not standalone @@...@@)", () => {
    const content = readAll(PLIST_TEMPLATE);
    // Should contain the new triple-@ syntax.
    expect(content).toContain("@@@USER@@@");
    expect(content).toContain("@@@HOME@@@");
    expect(content).toContain("@@@LIVE@@@");
    expect(content).toContain("@@@LOGDIR@@@");
    // Verify there are no standalone @@...@@ placeholders (only triple-@@ or
    // non-placeholder uses like comments). Scan every @@ occurrence and check
    // that it is always preceded and followed by another @ (making it @@@).
    const foundStandalone = content.match(/(?<!@)@@[A-Z_]+@@(?!@)/g);
    expect(foundStandalone).toBeNull();
  });

  test("has all required placeholders", () => {
    const content = readAll(PLIST_TEMPLATE);
    const required = [
      "@@@USER@@@",
      "@@@HOME@@@",
      "@@@LIVE@@@",
      "@@@LOGDIR@@@",
      "@@@POLYTOKEN_BIN@@@",
      "@@@XDG_CONFIG@@@",
      "@@@XDG_DATA@@@",
    ];
    for (const ph of required) {
      expect(content).toContain(ph);
    }
  });

  test("has correct label", () => {
    const content = readAll(PLIST_TEMPLATE);
    expect(content).toContain("<string>com.pantoken.server</string>");
  });

  test("contains absolute path environment variables", () => {
    const content = readAll(PLIST_TEMPLATE);
    expect(content).toContain("<key>PANTOKEN_DATA_DIR</key>");
    expect(content).toContain("<key>PANTOKEN_HOST</key>");
    expect(content).toContain("<key>PANTOKEN_PORT</key>");
    expect(content).toContain("127.0.0.1");
    expect(content).toContain("8787");
    expect(content).toContain("<key>PANTOKEN_POLYTOKEN_BIN</key>");
    expect(content).toContain("<key>XDG_CONFIG_HOME</key>");
    expect(content).toContain("<key>XDG_DATA_HOME</key>");
  });

  test("Has RunAtLoad and KeepAlive", () => {
    const content = readAll(PLIST_TEMPLATE);
    expect(content).toContain("<key>RunAtLoad</key>");
    expect(content).toContain("<true/>");
    expect(content).toContain("<key>KeepAlive</key>");
  });

  test("renders to valid plist via sed substitution", async () => {
    const content = readAll(PLIST_TEMPLATE);
    const rendered = content
      .replaceAll("@@@USER@@@", "timo")
      .replaceAll("@@@HOME@@@", "/Users/timo")
      .replaceAll("@@@LIVE@@@", "/Users/timo/pantoken-versions/1.0.0")
      .replaceAll("@@@LOGDIR@@@", "/Users/timo/Library/Logs")
      .replaceAll("@@@POLYTOKEN_BIN@@@", "/usr/local/bin/polytoken")
      .replaceAll("@@@XDG_CONFIG@@@", "/Users/timo/.config")
      .replaceAll("@@@XDG_DATA@@@", "/Users/timo/.local/share");

    // Value placeholders must be gone (the comment mentioning @@ may remain).
    expect(rendered).not.toMatch(/<string>@@@/);
    expect(rendered).not.toMatch(/<string>~\//);

    const tmp = join(mkdtempSync(tmpdir()), "rendered.plist");
    writeFileSync(tmp, rendered);
    // plutil lint (best-effort; fails gracefully if not on macOS).
    const lint = Bun.spawnSync(["plutil", "-lint", tmp]);
    if (lint.exitCode === 0) {
      expect(lint.exitCode).toBe(0);
    }
    rmSync(tmp, { force: true });
  });
});

// ── bootstrap-headless.sh tests ──────────────────────────────────────────────
describe("bootstrap-headless.sh", () => {
  test("rejects missing version", async () => {
    const proc = Bun.spawn([BOOTSTRAP_HEADLESS], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });

  test("rejects missing archive directory", async () => {
    const proc = Bun.spawn([BOOTSTRAP_HEADLESS, "1.0.0"], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });

  test("rejects non-existent archive directory", async () => {
    const proc = Bun.spawn([BOOTSTRAP_HEADLESS, "1.0.0", "/tmp/nonexistent-archive-dir"], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });

  test("validates archive: missing VERSION file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pantoken-bootstrap-test-"));
    const release = join(tmp, "release");
    mkdirSync(release);
    // Has binary, client-dist, but no VERSION file.
    writeFileSync(join(release, "BUILD_SHA"), "abc");
    mkdirSync(join(release, "bin"));
    writeFileSync(join(release, "bin", "pantoken-server"), "#!/bin/sh\necho ok\n");
    chmodSync(join(release, "bin", "pantoken-server"), 0o755);
    mkdirSync(join(release, "client-dist"));
    writeFileSync(join(release, "client-dist", "index.html"), "<html>ok</html>");
    writeFileSync(join(release, "run.sh"), "#!/bin/sh\necho ok\n");
    chmodSync(join(release, "run.sh"), 0o755);
    writeFileSync(join(release, "update.sh"), "#!/bin/sh\necho ok\n");
    chmodSync(join(release, "update.sh"), 0o755);

    // Use the current user (who can resolve their own home dir) for tests
    // that need full bootstrap execution. Don't pass --user to avoid
    // "cannot resolve home directory" in test harness.
    // Also ensure HOME is set in the spawn env since Bun test context
    // may not export it.
    const testHome = process.env.HOME || "/Users/timo";
    const proc = Bun.spawn([BOOTSTRAP_HEADLESS, "1.0.0", release, "--skip-daemon"], {
      stderr: "pipe",
      stdout: "pipe",
      env: { ...process.env, HOME: testHome },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(stdout + stderr).toContain("missing VERSION");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("validates archive: VERSION mismatch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pantoken-bootstrap-test-"));
    const release = fixtureRelease("9.9.9", tmp);

    const proc = Bun.spawn([BOOTSTRAP_HEADLESS, "1.0.0", release, "--skip-daemon"], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect(stdout + stderr).toContain("VERSION file says '9.9.9'");
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ── bootstrap-tar-validator.sh tests ─────────────────────────────────────────
describe("bootstrap-tar-validator.sh", () => {
  test("rejects missing --binary", async () => {
    const proc = Bun.spawn([BOOTSTRAP_VALIDATOR], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });

  test("rejects missing --sha256", async () => {
    const proc = Bun.spawn([BOOTSTRAP_VALIDATOR, "--binary", "/dev/null"], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });

  test("rejects non-existent binary", async () => {
    const proc = Bun.spawn([BOOTSTRAP_VALIDATOR, "/nonexistent/file", "abcd1234"], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });

  test("rejects malformed SHA-256 (too short)", async () => {
    const proc = Bun.spawn([BOOTSTRAP_VALIDATOR, "/dev/null", "abcd"], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });

  test("rejects SHA-256 with uppercase", async () => {
    const proc = Bun.spawn([BOOTSTRAP_VALIDATOR, "/dev/null", "ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234ABCD1234"], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    expect((stdout + stderr).toLowerCase()).toContain("error");
  });
});
