#!/usr/bin/env bun
// validate-artifact.ts — validate a headless release artifact's contents.
//
//   bun scripts/headless/validate-artifact.ts <archive.tar.gz> [--version <vX.Y.Z>]
//
// Checks:
//   1. Archive is valid gzip/tar (no malicious members)
//   2. Required files exist: VERSION, BUILD_SHA, bin/pantoken-server, run.sh, client-dist/index.html
//   3. VERSION matches --version if provided
//   4. BUILD_SHA is a 40-char lowercase hex SHA
//   5. bin/pantoken-server is executable
//   6. run.sh is executable
//   7. client-dist/index.html exists
//   8. No unexpected members (source trees, node_modules, etc.)
//
// Exit 0 on success, 1 on validation failure.

import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  chmodSync,
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

const ALLOWED_SUBDIRS = ["client-dist/assets"];

// Files/dirs that are NOT allowed anywhere in the archive
const FORBIDDEN_PATTERNS = [
  /node_modules/,
  /\.git(\/|$)/,
  /src\//,
  /\.cargo(\/|$)/,
  /target\//,
];

function fail(msg: string): never {
  console.error(`validate: ${msg}`);
  process.exit(1);
}

interface ListResult {
  code: number;
  stdout: string;
}

/**
 * List archive members using tar tvf, parse the output.
 */
function listMembers(archivePath: string): ListResult {
  const result = spawnSync("tar", ["tvf", archivePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });

  if (result.error) {
    return {
      code: 1,
      stdout: result.error.message || "",
    };
  }

  return { code: result.status ?? 1, stdout: result.stdout || "" };
}

function parseMembers(stdout: string): string[] {
  return stdout
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      // tar tvf output: permissions owner size date time path
      // Example: -rw-r--r-- user/group  1234 2024-01-01 00:00 path/to/file
      const parts = line.split(/\s+/);
      // The path is everything after the size field
      // Find where the path starts (after date/time)
      const pathIdx = parts.findIndex((p, i) => i > 3 && /^\d{4}-\d{2}-\d{2}/.test(p));
      if (pathIdx >= 0) {
        return parts.slice(pathIdx + 2).join(" ");
      }
      // Fallback: last 4+ tokens are path
      return parts.slice(-4).join(" ");
    })
    .filter(p => p.length > 0);
}

/**
 * Check if a path is a top-level directory entry (ends with /).
 */
function isDirectoryEntry(member: string): boolean {
  return member.endsWith("/");
}

/**
 * Check if a member path is safe (no absolute paths, no traversal, no links).
 */
function isMemberSafe(member: string): boolean {
  if (member.startsWith("/")) return false; // absolute path
  if (/^\.\/|\.\.\/|\/\.\./.test(member)) return false; // traversal
  if (member === "." || member === "..") return false; // root-only entries
  return true;
}

// ── argument parsing ──

function parseArgs(argv: string[]): { archive: string; version: string | null } {
  const args = argv;
  const archiveFlagIdx = args.findIndex(a => a !== "--version" && !a.startsWith("--version="));
  const archive = args[0];
  if (!archive || archive.startsWith("--"))
    fail(`usage: validate-artifact.ts <archive.tar.gz> [--version <vX.Y.Z>]`);

  const versionIdx = args.indexOf("--version");
  const version = versionIdx >= 0 && versionIdx + 1 < args.length
    ? (args[versionIdx + 1] ?? null)
    : null;

  return { archive, version };
}

// ── validation ──

async function validateArchive(archivePath: string): Promise<{
  members: string[];
  memberSet: Set<string>;
}> {
  console.log(`Checking archive: ${archivePath}`);

  if (!existsSync(archivePath))
    fail(`archive not found: ${archivePath}`);

  // The fixed-path validator is installed separately from the archive and must run
  // before any extraction. Test mode may point at a fixture validator only explicitly.
  const validator = process.env.PANTOKEN_UPDATE_TEST_MODE === "1"
    ? process.env.PANTOKEN_TAR_VALIDATOR ?? ""
    : `${process.env.HOME ?? ""}/.local/libexec/pantoken-tar-validate`;
  if (!validator || !existsSync(validator)) fail(`trusted tar validator missing: ${validator}`);
  const trusted = spawnSync(validator, [archivePath], { encoding: "utf8" });
  if (trusted.status !== 0) fail(`trusted tar validator rejected archive (exit ${trusted.status}): ${trusted.stderr || trusted.stdout}`);

  // Check gzip magic before the second, extracted-tree validation.
  const header = Bun.file(archivePath).slice(0, 2);
  const bytes = new Uint8Array(await header.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    fail(`not a valid gzip archive (magic bytes: ${(bytes[0] ?? 0).toString(16)} ${(bytes[1] ?? 0).toString(16)})`);

  // List members
  const result = listMembers(archivePath);
  if (result.code !== 0)
    fail(`tar list failed (code ${result.code}): ${result.stdout}`);

  const members = parseMembers(result.stdout);
  const memberSet = new Set(members);

  // Check for duplicates
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m))
      fail(`duplicate member: ${m}`);
    seen.add(m);
  }

  // Check all members are safe
  for (const m of members) {
    if (!isMemberSafe(m))
      fail(`unsafe member path: ${m}`);
  }

  return { members, memberSet };
}

function validateLayout(
  members: string[],
  memberSet: Set<string>,
): string[] {
  console.log("Checking archive layout...");

  // Check required files
  const missing: string[] = [];
  for (const req of REQUIRED_FILES) {
    if (!memberSet.has(req))
      missing.push(req);
  }

  // Check no top-level unexpected directory
  const topLevelDirs = members
    .filter(m => isDirectoryEntry(m))
    .map(d => d.slice(0, -1))
    .filter(d => d.length > 0 && !ALLOWED_SUBDIRS.some(a => d === a || d.startsWith(a + "/")));

  if (topLevelDirs.length > 0)
    fail(`unexpected top-level directories: ${topLevelDirs.join(", ")}`);

  // Check for forbidden patterns
  for (const m of members) {
    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.test(m))
        fail(`forbidden pattern in member '${m}': ${pat}`);
    }
  }

  // Check no unexpected top-level files
  const topLevelFiles = members
    .filter(m => !isDirectoryEntry(m) && m.indexOf("/") === -1)
    .filter(m => !["VERSION", "BUILD_SHA"].includes(m) && !m.endsWith("/"));

  for (const f of topLevelFiles) {
    if (!["run.sh", "update.sh", "VERSION", "BUILD_SHA"].includes(f))
      console.warn(`  warning: unexpected top-level file: ${f}`);
  }

  if (missing.length > 0)
    fail(`missing required files: ${missing.join(", ")}`);

  console.log(`  required files OK (${REQUIRED_FILES.length}/${REQUIRED_FILES.length})`);
  return missing;
}

function validateVersion(
  extractedDir: string,
  version: string | null,
): void {
  console.log("Validating VERSION...");

  const versionPath = join(extractedDir, "VERSION");
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
}

function validateBuildSha(extractedDir: string): void {
  console.log("Validating BUILD_SHA...");

  const shaPath = join(extractedDir, "BUILD_SHA");
  if (!existsSync(shaPath))
    fail("BUILD_SHA file not found in extracted tree");

  const shaContent = readFileSync(shaPath, "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(shaContent))
    fail(`invalid BUILD_SHA format: '${shaContent}' (expected 40-char lowercase hex)`);

  console.log(`  BUILD_SHA: ${shaContent.slice(0, 12)}...${shaContent.slice(-4)}`);
}

function validatePermissions(extractedDir: string): void {
  console.log("Checking executable permissions...");

  const checks = [
    { path: join(extractedDir, "bin", "pantoken-server"), desc: "bin/pantoken-server" },
    { path: join(extractedDir, "run.sh"), desc: "run.sh" },
  ];

  for (const { path: p, desc } of checks) {
    if (!existsSync(p))
      fail(`${desc} not found in extracted tree`);
    const st = statSync(p);
    const mode = st.mode;
    if (!(mode & 0o111))
      fail(`${desc} is not executable (mode: ${(mode & 0o777).toString(8)})`);
    console.log(`  ${desc}: executable (mode: ${(mode & 0o777).toString(8)})`);
  }
}

// ── main ──

async function main(): Promise<void> {
  const { archive, version } = parseArgs(process.argv.slice(2));

  const archivePath = resolve(archive);
  const extractDir = mkdtempSync(join(tmpdir(), "pantoken-validate-"));

  try {
    // Step 1: Validate archive integrity
    const { members, memberSet } = await validateArchive(archivePath);

    // Step 2: Validate layout (no traversal, no forbidden patterns)
    validateLayout(members, memberSet);

    // Step 3: Extract and validate contents
    const extractResult = spawnSync("tar", ["xzf", archivePath, "-C", extractDir, "--no-same-owner", "--no-same-permissions"], {
      encoding: "utf8",
    });
    if (extractResult.status !== 0)
      fail(`tar extract failed: ${extractResult.stderr || extractResult.stdout}`);

    validateVersion(extractDir, version);
    validateBuildSha(extractDir);
    validatePermissions(extractDir);
    for (const executable of ["run.sh", "update.sh", "bin/pantoken-server", "bin/pantoken-tar-validate"]) {
      chmodSync(join(extractDir, executable), 0o755);
    }
    const packaged = spawnSync(join(extractDir, "bin/pantoken-tar-validate"), [archivePath], { encoding: "utf8" });
    if (packaged.status !== 0) fail(`packaged tar validator rejected archive (exit ${packaged.status})`);

    console.log("\nValidated headless artifact: PASS");
    process.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
