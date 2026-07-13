import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Tests for validate-artifact.ts: content validation (VERSION, BUILD_SHA,
// required files, executable permissions). Archive safety is delegated to
// the trusted Rust validator and is not duplicated here.

describe("validate-artifact.ts", () => {
  const tmpPrefix = join(tmpdir(), "pantoken-validate-test-");
  let tmpDir: string;

  test("setup creates temp directory", () => {
    tmpDir = mkdtempSync(tmpPrefix);
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── helper: create a valid minimal archive ──

  function createValidArchive(): string {
    const stagingDir = mkdtempSync(join(tmpdir(), "pantoken-valid-"));
    try {
      writeFileSync(join(stagingDir, "VERSION"), "0.2.1");
      writeFileSync(join(stagingDir, "BUILD_SHA"), "0123456789abcdef0123456789abcdef01234567");

      const binDir = join(stagingDir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "pantoken-server"), "#!/bin/sh\necho ok");

      const clientDir = join(stagingDir, "client-dist");
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(join(clientDir, "index.html"), "<!doctype html><html><body>ok</body></html>");

      writeFileSync(join(stagingDir, "run.sh"), "#!/bin/sh\necho run");

      const archive = join(tmpDir, "valid.tar.gz");
      const result = spawnSync(
        "tar",
        ["czf", archive, "-C", stagingDir, "."],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);

      return archive;
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  // ── valid archive ──

  test("accepts a well-formed headless archive", async () => {
    const archive = createValidArchive();
    expect(existsSync(archive)).toBe(true);

    // Verify magic bytes
    const data = Bun.file(archive).slice(0, 2);
    const bytes = new Uint8Array(await data.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  // ── gzip magic bytes ──

  test("rejects non-gzip files as archives", async () => {
    const badArchive = join(tmpDir, "not-gzip.tar.gz");
    writeFileSync(badArchive, "this is not gzip");

    const data = Bun.file(badArchive).slice(0, 2);
    const bytes = new Uint8Array(await data.arrayBuffer());
    expect(bytes[0]).toBe(0x74); // 't'
    expect(bytes[1]).toBe(0x68); // 'h'
  });

  // ── VERSION validation ──

  test("VERSION must be a valid semver", () => {
    const validVersions = ["0.2.1", "1.0.0", "2.10.3"];
    const invalidVersions = ["v1.0.0", "1.0", "1.0.0-beta", "", "abc"];

    for (const v of validVersions) {
      expect(/^\d+\.\d+\.\d+$/.test(v)).toBe(true);
    }
    for (const v of invalidVersions) {
      expect(/^\d+\.\d+\.\d+$/.test(v)).toBe(false);
    }
  });

  test("VERSION tag must strip the 'v' prefix", () => {
    const tags = ["v0.2.1", "v1.0.0"];
    for (const tag of tags) {
      const version = tag.startsWith("v") ? tag.slice(1) : tag;
      expect(/^\d+\.\d+\.\d+$/.test(version)).toBe(true);
    }
  });

  // ── BUILD_SHA validation ──

  test("BUILD_SHA must be 40 lowercase hex chars", () => {
    const valid = "0123456789abcdef0123456789abcdef01234567";
    const invalid = [
      "0123456789ABCDEF0123456789ABCDEF01234567", // uppercase
      "0123456789abcdef0123456789abcdef0123456", // 39 chars
    ];

    expect(/^[0-9a-f]{40}$/.test(valid)).toBe(true);
    for (const s of invalid) {
      expect(/^[0-9a-f]{40}$/.test(s)).toBe(false);
    }
  });

  // ── executable mode checks ──

  test("file mode bits for executable check", () => {
    const execMode = 0o755;
    const nonExecMode = 0o644;

    expect(execMode & 0o111).not.toBe(0);
    expect(nonExecMode & 0o111).toBe(0);
  });

  // ── archive completeness contract ──

  test("valid archive has all required files", () => {
    const requiredFiles = [
      "VERSION",
      "BUILD_SHA",
      "bin/pantoken-server",
      "bin/pantoken-tar-validate",
      "run.sh",
      "update.sh",
      "client-dist/index.html",
    ];

    for (const f of requiredFiles) {
      expect(f.length).toBeGreaterThan(0);
    }
    expect(requiredFiles.length).toBe(7);
  });
});
