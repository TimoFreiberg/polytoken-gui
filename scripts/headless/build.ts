#!/usr/bin/env bun
// build.ts — build a headless release artifact for a supported target triple.
//
//   bun scripts/headless/build.ts [--target <triple>] [--dry-run] [--skip-build] [--tag <vMAJOR.MINOR.PATCH>]
//
// Default --target: aarch64-apple-darwin (the macOS arm64 host).
// Supported targets are defined in release-constants.ts HEADLESS_TARGETS and
// must match SUPPORTED_TARGET_TRIPLES in the Rust manifest module.
//
// Produces (per target):
//   target/release/headless/<asset>           (archive)
//   target/release/headless/<asset>.sig      (minisign signature)
//   target/release/headless/release-metadata.json  (aggregated, written by the
//       CI aggregation step or publish.ts, not by a single build invocation)
//
// The artifact contains:
//   VERSION              (plain text: MAJOR.MINOR.PATCH)
//   BUILD_SHA            (40-char lowercase hex)
//   bin/pantoken-server  (compiled Rust binary for the target)
//   run.sh               (runtime wrapper, executable)
//   update.sh            (updater, executable)
//   client-dist/index.html  (bundled static client)
//   client-dist/assets/<hashed>  (Vite-hashed static assets)
//
// No Bun, node_modules, or source checkout is shipped.

import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  RELEASE_REPO,
  HEADLESS_TARGETS,
  headlessTargetForTriple,
  TAURI_UPDATER_PUBLIC_KEY,
  assertReleaseTag,
} from "../desktop/release-constants";

const repoRoot = resolve(import.meta.dir, "../..");

// ── helpers ──

function fail(msg: string): never {
  console.error(`build: ${msg}`);
  process.exit(1);
}

interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function capture(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CaptureResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0)
    fail(`\`${cmd.join(" ")}\` failed — see output above`);
}

// ── argument parsing ──

function parseArgs(argv: string[]): {
  dryRun: boolean;
  skipBuild: boolean;
  tag: string | undefined;
  targetTriple: string;
} {
  const dryRun = argv.includes("--dry-run");
  const skipBuild = argv.includes("--skip-build");
  const tagIdx = argv.indexOf("--tag");
  const tag = tagIdx >= 0 ? argv[tagIdx + 1] : undefined;
  if (tagIdx >= 0 && !tag)
    fail("--tag needs a value (e.g. v0.2.1)");
  if (tag) assertReleaseTag(tag);
  const targetIdx = argv.indexOf("--target");
  const targetTriple =
    targetIdx >= 0
      ? (argv[targetIdx + 1] ?? fail("--target needs a value (e.g. x86_64-unknown-linux-gnu)"))
      : "aarch64-apple-darwin";
  // Validate against the supported matrix.
  headlessTargetForTriple(targetTriple);
  return { dryRun, skipBuild, tag, targetTriple };
}

// ── version extraction ──

/**
 * Derive the release version from the desktop bundle's Info.plist,
 * matching the publisher's authoritative version rule.
 */
async function extractVersionFromDesktop(tag: string | undefined): Promise<string> {
  const bundleDir = join(repoRoot, "target", "release", "bundle", "macos");
  const tarPath = join(bundleDir, "Pantoken.app.tar.gz");

  if (!existsSync(tarPath))
    fail(
      `desktop artifact missing: ${tarPath}. ` +
        `Run the desktop build first or use --skip-build with a pre-existing artifact.`,
    );

  const extractDir = mkdtempSync(join(tmpdir(), "pantoken-version-"));
  try {
    const extracted = await capture(["tar", "xzf", tarPath, "-C", extractDir]);
    if (extracted.code !== 0)
      throw new Error(`couldn't extract desktop archive: ${extracted.stderr}`);

    const appPath = join(extractDir, "Pantoken.app");
    if (!existsSync(appPath))
      throw new Error(`desktop archive did not contain Pantoken.app: ${tarPath}`);

    const plist = await capture([
      "plutil",
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      join(appPath, "Contents", "Info.plist"),
    ]);
    if (plist.code !== 0)
      throw new Error(`couldn't read bundle version: ${plist.stderr}`);

    const version = plist.stdout.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new Error(`implausible bundle version '${version}'`);

    return version;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

// ── build SHA ──

/**
 * Get the full 40-char lowercase hex Git SHA.
 * For CI, GITHUB_SHA is set; locally, fall back to git rev-parse.
 */
async function resolveBuildSha(cliTag: string | undefined): Promise<string> {
  if (process.env.GITHUB_SHA) {
    const sha = process.env.GITHUB_SHA;
    if (!/^[0-9a-f]{40}$/.test(sha))
      fail(`GITHUB_SHA is not a valid 40-char lowercase hex SHA: ${sha}`);
    return sha;
  }

  // Fallback: git rev-parse HEAD
  const head = await capture(["git", "rev-parse", "HEAD"], { cwd: repoRoot });
  const sha = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha))
    fail(`could not resolve full Git SHA: ${sha || head.stderr.trim()}`);
  return sha;
}

// ── build client-dist ──

/**
 * Build the Vite client and return the output directory path.
 */
async function buildClientDist(): Promise<string> {
  console.log("Building client-dist (Vite)...");
  await run(["bun", "run", "--cwd", join(repoRoot, "client"), "build"]);
  return join(repoRoot, "client", "dist");
}

// ── tar assembly ──

/**
 * The canonical direct-root archive layout:
 *   VERSION
 *   BUILD_SHA
 *   bin/pantoken-server
 *   run.sh
 *   update.sh
 *   client-dist/index.html
 *   client-dist/assets/<hashed>
 *
 * No nested prefix directory, no source, no node_modules.
 */
async function assembleTarGz(
  version: string,
  buildSha: string,
  outputDir: string,
  clientDist: string,
  binaryPath: string,
  assetName: string,
): Promise<string> {
  const stagingDir = mkdtempSync(join(tmpdir(), "pantoken-headless-"));
  try {
    // Write VERSION and BUILD_SHA
    writeFileSync(join(stagingDir, "VERSION"), version);
    writeFileSync(join(stagingDir, "BUILD_SHA"), buildSha);

    // Copy binary
    const binDir = join(stagingDir, "bin");
    mkdirRecursively(binDir);
    copyFileSync(binaryPath, join(binDir, "pantoken-server"));
    chmodSync(join(binDir, "pantoken-server"), 0o755);

    // Copy run.sh from deploy
    const runSrc = join(repoRoot, "deploy", "run.sh");
    if (!existsSync(runSrc))
      fail(`deploy/run.sh not found at ${runSrc}`);
    copyFileSync(runSrc, join(stagingDir, "run.sh"));
    chmodSync(join(stagingDir, "run.sh"), 0o755);

    // Copy the canonical updater; an artifact without it is invalid.
    const updateSrc = join(repoRoot, "deploy", "update-headless.sh");
    if (!existsSync(updateSrc)) fail(`deploy/update-headless.sh not found at ${updateSrc}`);
    copyFileSync(updateSrc, join(stagingDir, "update.sh"));
    chmodSync(join(stagingDir, "update.sh"), 0o755);

    // Copy the separately trusted validator into the payload for inspection only.
    const validatorPath = join(repoRoot, "target", "release", "pantoken-tar-validate");
    if (!existsSync(validatorPath)) fail(`validator binary not found: ${validatorPath}`);
    copyFileSync(validatorPath, join(binDir, "pantoken-tar-validate"));
    chmodSync(join(binDir, "pantoken-tar-validate"), 0o755);

    // Copy client-dist
    const clientDistOut = join(stagingDir, "client-dist");
    copyDirRecursive(clientDist, clientDistOut);

    // Build tar.gz (no wrapper prefix, direct root)
    // COPYFILE_DISABLE=1 prevents BSD tar from adding AppleDouble (._*) metadata.
    // The Rust tar validator handles directory entries (bin/, client-dist/) correctly,
    // so we use a normal recursive archive command.
    const tarCmd = await capture(
      ["tar", "czf", join(outputDir, assetName), "-C", stagingDir, "."],
      { env: { COPYFILE_DISABLE: "1" } },
    );
    if (tarCmd.code !== 0)
      fail(`tar failed: ${tarCmd.stderr}`);

    return join(outputDir, assetName);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ── minisign signing ──

/**
 * Sign the headless tar.gz with minisign.
 * The signing key is TAURI_SIGNING_PRIVATE_KEY_TEXT (raw minisign key text),
 * not the Tauri plugin format. We write it to a temp file for standalone minisign.
 */
async function signWithMinisign(
  archivePath: string,
  keyText: string,
  keyPassword: string = "",
): Promise<string> {
  if (!keyText)
    fail("TAURI_SIGNING_PRIVATE_KEY_TEXT is required for minisign signing");

  const tmpDir = mkdtempSync(join(tmpdir(), "pantoken-sign-"));
  try {
    const keyFile = join(tmpDir, "pantoken-sign.key");
    writeFileSync(keyFile, keyText, { mode: 0o600 });

    // Pipe the password via stdin so minisign doesn't prompt interactively.
    // Even an empty-password-encrypted key needs an empty line on stdin.
    const proc = Bun.spawn(
      ["minisign", "-S", "-s", keyFile, "-x", `${archivePath}.sig`, "-m", archivePath],
      { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
    );
    proc.stdin.write(`${keyPassword}\n`);
    proc.stdin.end();
    const [stderr] = await Promise.all([
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0)
      fail(`minisign sign failed: ${stderr}`);

    return `${archivePath}.sig`;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── metadata ──

interface HeadlessTargetMetadata {
  targetTriple: string;
  asset: string;
  signature: string;
  assetSha256: string;
  signatureSha256: string;
}

interface ReleaseMetadata {
  tag: string;
  version: string;
  buildSha: string;
  releaseRepo: string;
  desktopAsset: string;
  desktopSignature: string;
  latestJsonAsset: string;
  headlessTargets: HeadlessTargetMetadata[];
  assetSha256: Record<string, string>;
}

async function requiredAssetSha(outputDir: string, name: string): Promise<string> {
  const path = join(outputDir, name);
  if (!existsSync(path)) fail(`release bundle missing required asset ${name}`);
  return fileSha256(path);
}

async function writeMetadata(
  metadata: ReleaseMetadata,
  outputDir: string,
): Promise<void> {
  const metaPath = join(outputDir, "release-metadata.json");
  await Bun.write(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

// ── file SHA-256 ──

async function fileSha256(path: string): Promise<string> {
  const data = await Bun.file(path).arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── mkdir helper ──

function mkdirRecursively(dir: string): void {
  const parent = dir.split("/").slice(0, -1).join("/");
  if (parent && !existsSync(parent)) mkdirRecursively(parent);
  if (!existsSync(dir)) mkdirSync(dir);
}

// ── copy dir recursive ──

function copyDirRecursive(src: string, dst: string): void {
  mkdirRecursively(dst);
  for (const name of readdirSync(src)) {
    if (name === ".pantoken-built-sha") continue;
    const srcPath = join(src, name);
    const dstPath = join(dst, name);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      if (name !== "assets") fail(`unexpected client-dist directory: ${name}`);
      copyDirRecursive(srcPath, dstPath);
    } else if (
      name === "index.html" ||
      src.includes(`${join("client", "dist", "assets")}`) ||
      name.match(/^(apple-touch-icon|icon|favicon|manifest|sw)\b.*$/)
    ) {
      copyFileSync(srcPath, dstPath);
    } else {
      fail(`unexpected client-dist file: ${name}`);
    }
  }
}

// ── main ──

if (import.meta.main) {
  const { dryRun, skipBuild, tag: cliTag, targetTriple } = parseArgs(process.argv.slice(2));
  const target = headlessTargetForTriple(targetTriple);

  // ── preflight: platform ──
  // Each target must be built on its native runner so the binary actually runs
  // on the target platform (no cross-compilation).
  if (targetTriple === "aarch64-apple-darwin") {
    if (process.platform !== "darwin")
      fail(`aarch64-apple-darwin build requires macOS (host: ${process.platform})`);
    if (process.arch !== "arm64")
      fail(`aarch64-apple-darwin build requires arm64 (host: ${process.arch})`);
  } else if (targetTriple === "x86_64-unknown-linux-gnu") {
    if (process.platform !== "linux")
      fail(`x86_64-unknown-linux-gnu build requires Linux (host: ${process.platform})`);
    if (process.arch !== "x64")
      fail(`x86_64-unknown-linux-gnu build requires x86_64 (host: ${process.arch})`);
  }

  // ── build SHA ──
  const buildSha = await resolveBuildSha(cliTag);

  // ── build Rust binary ──
  let binaryPath: string;
  if (!skipBuild) {
    console.log("Building pantoken-server (Cargo release)...");
    const serverRs = join(repoRoot, "server-rs");
    await run(["cargo", "build", "--release", "-p", "pantoken-server", "-p", "pantoken-tar-validate"], {
      cwd: repoRoot,
      env: {
        PANTOKEN_RELEASE_BUILD: "1",
        PANTOKEN_BUILD_SHA: buildSha,
      },
    });
    binaryPath = join(repoRoot, "target", "release", "pantoken-server");
    if (!existsSync(binaryPath))
      fail(`built binary not found: ${binaryPath}`);
  } else {
    // In skip-build mode, look for an existing binary
    binaryPath = join(
      repoRoot,
      "target",
      "release",
      "pantoken-server",
    );
    if (!existsSync(binaryPath))
      fail(
        `--skip-build: no existing binary at ${binaryPath}. ` +
          `Build first or ensure the binary exists.`,
      );
  }

  // ── build / locate client-dist ──
  let clientDist: string;
  if (!skipBuild) {
    clientDist = await buildClientDist();
  } else {
    // Assume client/dist exists from a prior build
    clientDist = join(repoRoot, "client", "dist");
    if (!existsSync(join(clientDist, "index.html")))
      fail(
        `--skip-build: no client/dist/index.html found. ` +
          `Build the client first.`,
      );
  }

  // ── extract version ──
  // The version comes from the release tag if provided. On macOS, the desktop
  // bundle's Info.plist is the fallback. On Linux (no desktop bundle), the tag
  // is required for release builds.
  const tagPrefix = cliTag ? assertReleaseTag(cliTag).slice(1) : undefined;
  let version: string;
  if (tagPrefix) {
    version = tagPrefix;
  } else if (process.platform === "darwin") {
    version = await extractVersionFromDesktop(cliTag);
  } else {
    // Non-macOS without a tag: read the version from desktop/Cargo.toml as a
    // best-effort fallback (dev/local builds only — release builds always pass --tag).
    const cargo = await Bun.file(join(repoRoot, "desktop", "Cargo.toml")).text();
    const m = cargo.match(/^version\s*=\s*"(\d+\.\d+\.\d+)"/m);
    if (!m) fail("could not extract version from desktop/Cargo.toml — pass --tag");
    version = m[1]!;
    console.log(`[warning] no --tag; using version ${version} from desktop/Cargo.toml (dev build)`);
  }

  // ── assemble tar.gz ──
  const outputDir = join(repoRoot, "target", "release", "headless");
  mkdirSync(outputDir, { recursive: true });
  const archivePath = await assembleTarGz(
    version,
    buildSha,
    outputDir,
    clientDist,
    binaryPath,
    target.asset,
  );
  console.log(`Assembled archive: ${archivePath}`);

  // ── sign with minisign ──
  const keyText = process.env.TAURI_SIGNING_PRIVATE_KEY_TEXT ?? process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!keyText)
    fail(
      "TAURI_SIGNING_PRIVATE_KEY_TEXT is required. " +
        "Export the minisign-format private key (not the Tauri plugin key).",
    );
  // The key may be password-encrypted (even with an empty password string).
  // Pipe the password via stdin so minisign doesn't prompt interactively.
  const keyPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  const sigPath = await signWithMinisign(archivePath, keyText, keyPassword);
  console.log(`Signed archive: ${sigPath}`);

  // ── verify the signature locally ──
  // TAURI_UPDATER_PUBLIC_KEY is base64-encoded (comment + key line).
  // minisign -P expects the raw public key line, so decode and extract it.
  const pubKeyDecoded = Buffer.from(TAURI_UPDATER_PUBLIC_KEY, "base64").toString("utf8");
  const pubKeyLine = pubKeyDecoded.split("\n").find(l => l.startsWith("RW"));
  if (!pubKeyLine)
    fail("could not extract raw public key from TAURI_UPDATER_PUBLIC_KEY");
  const rawPubKey: string = pubKeyLine;
  const verification = await capture([
    "minisign",
    "-Vm",
    archivePath,
    "-x",
    `${archivePath}.sig`,
    "-P",
    rawPubKey,
  ]);
  if (verification.code !== 0)
    fail(`local signature verification failed: ${verification.stderr}`);
  console.log("Local minisign verification passed.");

  // ── write metadata ──
  // A single build invocation writes metadata for its target only. The CI
  // aggregation step (or publish.ts --skip-build) merges per-target metadata
  // into the final release-metadata.json.
  const tagStr = cliTag ?? `v${version}`;
  const archiveSha = await fileSha256(archivePath);
  const sigSha = await fileSha256(sigPath);

  // Desktop assets exist only on the macOS runner; skip them on Linux.
  const desktopDir = join(repoRoot, "target", "release", "bundle", "macos");
  const hasDesktopBundle = existsSync(join(desktopDir, "Pantoken.app.tar.gz"));

  const headlessTargetEntry: HeadlessTargetMetadata = {
    targetTriple: target.targetTriple,
    asset: target.asset,
    signature: target.signature,
    assetSha256: archiveSha,
    signatureSha256: sigSha,
  };

  const assetSha256: Record<string, string> = {
    [target.asset]: archiveSha,
    [target.signature]: sigSha,
  };

  if (hasDesktopBundle) {
    assetSha256["Pantoken.app.tar.gz"] = await requiredAssetSha(desktopDir, "Pantoken.app.tar.gz");
    assetSha256["Pantoken.app.tar.gz.sig"] = await requiredAssetSha(desktopDir, "Pantoken.app.tar.gz.sig");
    assetSha256["latest.json"] = await requiredAssetSha(desktopDir, "latest.json");
  }

  await writeMetadata(
    {
      tag: tagStr,
      version,
      buildSha,
      releaseRepo: RELEASE_REPO,
      desktopAsset: hasDesktopBundle ? "Pantoken.app.tar.gz" : "",
      desktopSignature: hasDesktopBundle ? "Pantoken.app.tar.gz.sig" : "",
      latestJsonAsset: hasDesktopBundle ? "latest.json" : "",
      headlessTargets: [headlessTargetEntry],
      assetSha256,
    },
    outputDir,
  );

  // ── summary ──
  console.log(`\n=== Headless release ${tagStr} ===`);
  console.log(`  archive:   ${archivePath}`);
  console.log(`  signature: ${sigPath}`);
  console.log(`  version:   ${version}`);
  console.log(`  buildSha:  ${buildSha}`);
  console.log(`  metadata:  ${join(outputDir, "release-metadata.json")}`);
  console.log(`  repo:      ${RELEASE_REPO}`);

  if (dryRun) {
    console.log("\n[dry-run] skipping publish step");
    process.exit(0);
  }
}
