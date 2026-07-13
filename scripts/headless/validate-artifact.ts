#!/usr/bin/env bun
// validate-artifact.ts — validate a headless release artifact's contents.
//
//   bun scripts/headless/validate-artifact.ts <archive.tar.gz> [--version <vX.Y.Z>]
//
// This script performs CONTENT validation only. Archive safety (path traversal,
// symlinks, devices, forbidden patterns, canonical schema, required members)
// is handled by the trusted Rust validator (pantoken-tar-validate), which is
// invoked once before extraction. This script does NOT re-parse tar listings
// or duplicate the Rust validator's safety checks.
//
// Checks performed here:
//   1. Invoke the trusted Rust validator (archive safety + schema)
//   2. Check gzip magic bytes
//   3. Extract to a temp directory
//   4. Validate VERSION format and optional tag match
//   5. Validate BUILD_SHA is 40-char lowercase hex
//   6. Validate required files exist
//   7. Validate executable permissions on bin/pantoken-server and run.sh
//
// Exit 0 on success, 1 on validation failure.

import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REQUIRED_FILES = [
  "VERSION",
  "BUILD_SHA",
  "bin/pantoken-server",
  "bin/pantoken-tar-validate",
  "run.sh",
  "update.sh",
  "client-dist/index.html",
];

function fail(msg: string): never {
  console.error(`validate: ${msg}`);
  process.exit(1);
}

// ── argument parsing ──

function parseArgs(argv: string[]): { archive: string; version: string | null } {
  const archive = argv[0];
  if (!archive || archive.startsWith("--"))
    fail(`usage: validate-artifact.ts <archive.tar.gz> [--version <vX.Y.Z>]`);

  const versionIdx = argv.indexOf("--version");
  const version = versionIdx >= 0 && versionIdx + 1 < argv.length
    ? (argv[versionIdx + 1] ?? null)
    : null;

  return { archive, version };
}

// ── main ──

async function main(): Promise<void> {
  const { archive, version } = parseArgs(process.argv.slice(2));

  const archivePath = resolve(archive);
  const extractDir = mkdtempSync(join(tmpdir(), "pantoken-validate-"));

  try {
    console.log(`Checking archive: ${archivePath}`);

    if (!existsSync(archivePath))
      fail(`archive not found: ${archivePath}`);

    // Step 1: Invoke the trusted Rust validator for archive safety + schema.
    // This is the single canonical archive-safety gate — it handles path
    // traversal, symlinks, devices, forbidden patterns, canonical member
    // schema, required members, and mode/owner checks.
    const validator = process.env.PANTOKEN_UPDATE_TEST_MODE === "1"
      ? process.env.PANTOKEN_TAR_VALIDATOR ?? ""
      : `${process.env.HOME ?? ""}/.local/libexec/pantoken-tar-validate`;
    if (!validator || !existsSync(validator))
      fail(`trusted tar validator missing: ${validator}`);
    const trusted = spawnSync(validator, [archivePath], { encoding: "utf8" });
    if (trusted.status !== 0)
      fail(`trusted tar validator rejected archive (exit ${trusted.status}): ${trusted.stderr || trusted.stdout}`);
    console.log(`  trusted validator: OK (${trusted.stdout.trim()})`);

    // Step 2: Check gzip magic bytes.
    const header = Bun.file(archivePath).slice(0, 2);
    const bytes = new Uint8Array(await header.arrayBuffer());
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
      fail(`not a valid gzip archive (magic bytes: ${(bytes[0] ?? 0).toString(16)} ${(bytes[1] ?? 0).toString(16)})`);

    // Step 3: Extract to temp directory.
    const extractResult = spawnSync(
      "tar",
      ["xzf", archivePath, "-C", extractDir, "--no-same-owner", "--no-same-permissions"],
      { encoding: "utf8" },
    );
    if (extractResult.status !== 0)
      fail(`tar extract failed: ${extractResult.stderr || extractResult.stdout}`);

    // Step 4: Validate VERSION.
    console.log("Validating VERSION...");
    const versionPath = join(extractDir, "VERSION");
    if (!existsSync(versionPath))
      fail("VERSION file not found in extracted tree");
    const versionContent = readFileSync(versionPath, "utf8").trim();
    if (!/^\d+\.\d+\.\d+$/.test(versionContent))
      fail(`invalid VERSION format: '${versionContent}'`);
    if (version) {
      const expectedVersion = version.startsWith("v") ? version.slice(1) : version;
      if (versionContent !== expectedVersion)
        fail(`VERSION mismatch: archive has '${versionContent}', expected '${expectedVersion}'`);
      console.log(`  VERSION: ${versionContent} (matches expected)`);
    } else {
      console.log(`  VERSION: ${versionContent}`);
    }

    // Step 5: Validate BUILD_SHA.
    console.log("Validating BUILD_SHA...");
    const shaPath = join(extractDir, "BUILD_SHA");
    if (!existsSync(shaPath))
      fail("BUILD_SHA file not found in extracted tree");
    const shaContent = readFileSync(shaPath, "utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(shaContent))
      fail(`invalid BUILD_SHA format: '${shaContent}' (expected 40-char lowercase hex)`);
    console.log(`  BUILD_SHA: ${shaContent.slice(0, 12)}...${shaContent.slice(-4)}`);

    // Step 6: Validate required files exist.
    console.log("Checking required files...");
    const missing: string[] = [];
    for (const req of REQUIRED_FILES) {
      if (!existsSync(join(extractDir, req)))
        missing.push(req);
    }
    if (missing.length > 0)
      fail(`missing required files: ${missing.join(", ")}`);
    console.log(`  required files OK (${REQUIRED_FILES.length}/${REQUIRED_FILES.length})`);

    // Step 7: Validate executable permissions.
    console.log("Checking executable permissions...");
    const execChecks = [
      { path: join(extractDir, "bin", "pantoken-server"), desc: "bin/pantoken-server" },
      { path: join(extractDir, "run.sh"), desc: "run.sh" },
    ];
    for (const { path: p, desc } of execChecks) {
      if (!existsSync(p))
        fail(`${desc} not found in extracted tree`);
      const st = statSync(p);
      const mode = st.mode;
      if (!(mode & 0o111))
        fail(`${desc} is not executable (mode: ${(mode & 0o777).toString(8)})`);
      console.log(`  ${desc}: executable (mode: ${(mode & 0o777).toString(8)})`);
    }

    console.log("\nValidated headless artifact: PASS");
    process.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
