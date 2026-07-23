#!/usr/bin/env bun
// publish.ts — build and publish a desktop release (the bundled .app: shell + compiled
// hub + client) plus the static updater manifest the running apps poll.
//
//   bun scripts/desktop/publish.ts --repo <owner/name> [--dry-run] [--skip-build]
//
// The repo is a GitHub RELEASES repo (public: installed apps download from it without
// credentials) — it does NOT have to be the code remote. Override via
// PANTOKEN_RELEASE_REPO instead of --repo if you prefer env config.
//
// Safety properties, learned from the spike (docs/ADR-desktop-shell.md):
// - **latest.json's `version` is read from the BUILT bundle's Info.plist**, never from
//   config: a manifest version that outruns the artifact makes every relaunch "update"
//   again — an infinite install loop under the unattended policy.
// - Refuses to overwrite an existing release tag: bump `version` in
//   desktop/tauri.conf.json (keep Cargo.toml in step) and rebuild instead.
// - Signing key comes from TAURI_SIGNING_PRIVATE_KEY or ~/.tauri/pantoken-shell.key —
//   missing key fails BEFORE the (multi-minute) build, not after.
//
// Apps consume releases via the stable endpoint
//   https://github.com/<owner/name>/releases/latest/download/latest.json
// (each release carries its own latest.json asset; GitHub's `latest` alias serves the
// newest release's copy). Put that URL in PANTOKEN_SHELL_UPDATE_URL or the data dir's
// `shell-update-url` file — see desktop/README.md "Updates".

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DESKTOP_ASSET,
  DESKTOP_SIGNATURE,
  HEADLESS_TARGETS,
  RELEASE_REPO,
  assertReleaseTag,
  desktopUpdateEndpoint,
  releaseAssetUrl,
} from "./release-constants";

const repoRoot = resolve(import.meta.dir, "../..");
const bundleDir = process.env.PANTOKEN_RELEASE_BUNDLE_DIR
  ? resolve(repoRoot, process.env.PANTOKEN_RELEASE_BUNDLE_DIR)
  : join(repoRoot, "target", "release", "bundle", "macos");

function fail(msg: string): never {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

async function sha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validateRetainedHeadlessBundle(dir: string, tag: string, version: string): Promise<void> {
  const metadataPath = join(dir, "release-metadata.json");
  if (!existsSync(metadataPath)) fail(`retained release metadata missing: ${metadataPath}`);
  const metadata = await Bun.file(metadataPath).json() as {
    tag?: string;
    version?: string;
    buildSha?: string;
    releaseRepo?: string;
    headlessTargets?: Array<{
      targetTriple: string;
      asset: string;
      signature: string;
      assetSha256: string;
      signatureSha256: string;
    }>;
    assetSha256?: Record<string, string>;
  };
  if (metadata.tag !== tag || metadata.version !== version || metadata.releaseRepo !== RELEASE_REPO)
    fail("retained release metadata disagrees with desktop artifact/tag/release host");
  if (!/^[0-9a-f]{40}$/.test(metadata.buildSha ?? "")) fail("retained metadata has invalid buildSha");

  // Validate every headless target in the matrix is present with a matching digest.
  if (!metadata.headlessTargets || metadata.headlessTargets.length === 0)
    fail("retained metadata has no headlessTargets — was the metadata aggregated from all target builds?");

  const presentTriples = new Set(metadata.headlessTargets.map((t) => t.targetTriple));
  for (const target of HEADLESS_TARGETS) {
    if (!presentTriples.has(target.targetTriple))
      fail(`retained metadata is missing headless target ${target.targetTriple} (${target.asset})`);
  }

  for (const ht of metadata.headlessTargets) {
    const archive = join(dir, ht.asset);
    const signature = join(dir, ht.signature);
    for (const path of [archive, signature])
      if (!existsSync(path)) fail(`retained headless asset missing: ${path}`);
    if (await sha256(archive) !== ht.assetSha256)
      fail(`retained metadata digest mismatch for ${ht.asset}`);
    if (await sha256(signature) !== ht.signatureSha256)
      fail(`retained metadata digest mismatch for ${ht.signature}`);
  }

  // Cross-check the flat assetSha256 map too.
  const expected = metadata.assetSha256 ?? {};
  for (const target of HEADLESS_TARGETS) {
    if (expected[target.asset] !== await sha256(join(dir, target.asset)))
      fail(`retained metadata flat-digest mismatch for ${target.asset}`);
  }

  const validator = process.env.PANTOKEN_TAR_VALIDATOR;
  if (validator) {
    for (const target of HEADLESS_TARGETS) {
      const archive = join(dir, target.asset);
      const checked = await capture([validator, archive]);
      if (checked.code !== 0) fail(`retained ${target.asset} failed tar validation: ${checked.stderr}`);
    }
  }
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

/** Run loudly (inherited stdio), throw on failure. For the build. */
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

/** darwin-aarch64 / darwin-x86_64 — the platform key the updater plugin matches. */
function platformKey(): string {
  if (process.platform !== "darwin")
    fail(`publishing is macOS-only for now (host: ${process.platform})`);
  return process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
}

function parseArgs(argv: string[]): {
  repo: string;
  dryRun: boolean;
  skipBuild: boolean;
  mustMatchTag: string | undefined;
} {
  const dryRun = argv.includes("--dry-run");
  const skipBuild = argv.includes("--skip-build");
  const flagIdx = argv.indexOf("--repo");
  const requestedRepo =
    (flagIdx >= 0 ? argv[flagIdx + 1] : undefined) ??
    process.env.PANTOKEN_RELEASE_REPO ??
    RELEASE_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(requestedRepo))
    fail(`invalid release repo '${requestedRepo}'`);
  if (requestedRepo !== RELEASE_REPO)
    fail(`release repo must be canonical ${RELEASE_REPO}, got ${requestedRepo}`);
  const repo = requestedRepo;
  const tagIdx = argv.indexOf("--tag-must-match");
  const mustMatchTag = tagIdx >= 0 ? argv[tagIdx + 1] : undefined;
  if (tagIdx >= 0 && !mustMatchTag)
    fail("--tag-must-match needs a value (the pushed git tag, e.g. v0.2.1)");
  if (mustMatchTag) assertReleaseTag(mustMatchTag);
  return { repo, dryRun, skipBuild, mustMatchTag };
}

/** The signing key the build needs to produce updater artifacts. Env wins; falls back
 *  to the keyfile the README documents. Fails loud BEFORE the build. */
function signingEnv(): Record<string, string> {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) {
    return {
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    };
  }
  const keyfile = join(homedir(), ".tauri", "pantoken-shell.key");
  if (!existsSync(keyfile)) {
    fail(
      `no updater signing key: set TAURI_SIGNING_PRIVATE_KEY or create ${keyfile} ` +
        `(bunx tauri signer generate -w ${keyfile}) — without it the build can't ` +
        `produce updater artifacts. In CI, add the key file's CONTENTS as an Actions ` +
        `secret: gh secret set TAURI_SIGNING_PRIVATE_KEY < ${keyfile}`,
    );
  }
  return {
    TAURI_SIGNING_PRIVATE_KEY: keyfile, // the plugin accepts a path or the key text
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  };
}

if (import.meta.main) {
  const { repo, dryRun, skipBuild, mustMatchTag } = parseArgs(
    process.argv.slice(2),
  );

  // ── preflight ──
  // Publication requires GH_TOKEN (set by CI via GITHUB_TOKEN or locally via
  // `gh auth login`). For non-dry-run runs, GH_TOKEN must be present.
  if (!dryRun && !process.env.GH_TOKEN) {
    fail("GH_TOKEN is required for publication (CI sets it via secrets.GITHUB_TOKEN)");
  }
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    const gh = await capture(["gh", "auth", "status"]);
    if (gh.code !== 0 && !dryRun) {
      fail(
        `\`gh auth status\` failed — install GitHub CLI and run \`gh auth login\`.\n${gh.stderr}`,
      );
    }
  }
  // Signing env is only needed when building; --skip-build publishes
  // pre-built artifacts and doesn't sign anything.
  const sign = skipBuild ? {} : signingEnv();

  // Fast tag guard before the multi-minute build: the pushed tag must match the
  // version about to be built (tauri.conf.json). The authoritative check happens
  // again below against the BUILT bundle. Skipped with --skip-build, where existing
  // artifacts (not the config) are what's being published.
  if (mustMatchTag && !skipBuild) {
    const conf = (await Bun.file(
      join(repoRoot, "desktop", "tauri.conf.json"),
    ).json()) as { version?: string };
    if (`v${conf.version}` !== mustMatchTag) {
      fail(
        `tag ${mustMatchTag} does not match tauri.conf.json version ${conf.version} — ` +
          `tag the commit that bumps the version (scripts/desktop/release.ts does both).`,
      );
    }
  }

  // ── build (signed, updater artifacts included) ──
  if (!skipBuild) {
    await run(["bun", "run", "build"], {
      cwd: join(repoRoot, "desktop"),
      env: sign,
    });
  }

  // ── locate + validate artifacts ──
  // Tauri packages the app into the updater archive and then removes the raw .app.
  // Validate the archive, rather than requiring an intermediate artifact that may no
  // longer exist after `tauri build` completes.
  const tar = join(bundleDir, "Pantoken.app.tar.gz");
  const sig = `${tar}.sig`;
  for (const p of [tar, sig]) {
    if (!existsSync(p))
      fail(
        `expected artifact missing: ${p} (did the build produce updater artifacts?)`,
      );
  }

  // The version OF THE ARTIFACT — from the archive's plist, not from any config file.
  const extractDir = mkdtempSync(join(tmpdir(), "pantoken-release-"));
  const app = join(extractDir, "Pantoken.app");
  let version: string;
  try {
    const extracted = await capture(["tar", "xzf", tar, "-C", extractDir]);
    if (extracted.code !== 0)
      throw new Error(`couldn't extract updater archive: ${extracted.stderr}`);
    if (!existsSync(app))
      throw new Error(`updater archive did not contain Pantoken.app: ${tar}`);
    const plist = await capture([
      "plutil",
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      join(app, "Contents", "Info.plist"),
    ]);
    if (plist.code !== 0)
      throw new Error(`couldn't read bundle version: ${plist.stderr}`);
    version = plist.stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(version))
      throw new Error(`implausible bundle version '${version}'`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
  const tag = `v${version}`;

  // The authoritative tag guard: what was BUILT must be what the pushed tag names —
  // a mismatched manifest is the infinite-update-loop failure mode.
  if (mustMatchTag && tag !== mustMatchTag) {
    fail(
      `built bundle is ${tag} but the pushed tag is ${mustMatchTag} — refusing to ` +
        `publish a manifest that disagrees with its artifact.`,
    );
  }

  // ── compose latest.json ──
  const signature = (await Bun.file(sig).text()).trim();
  const manifest = {
    version,
    pub_date: new Date().toISOString(),
    platforms: {
      [platformKey()]: {
        url: releaseAssetUrl(tag, DESKTOP_ASSET),
        signature,
      },
    },
  };
  const manifestPath = join(bundleDir, "latest.json");
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const head = await capture(["git", "-C", repoRoot, "rev-parse", "HEAD"]);
  const sha = head.code === 0 ? head.stdout.trim() : "unknown";
  const endpoint = desktopUpdateEndpoint();
  if (skipBuild) await validateRetainedHeadlessBundle(bundleDir, tag, version);
  console.log(`\nrelease ${tag} → ${repo}`);
  console.log(`  bundle:   ${tar}`);
  console.log(`  manifest: ${manifestPath}`);
  console.log(`  commit:   ${sha}`);
  console.log(`  endpoint: ${endpoint}\n`);

  if (dryRun) {
    console.log("[dry-run] would `gh release create` with the assets above");
    process.exit(0);
  }
  if (!process.env.GH_TOKEN)
    fail("missing explicit release-host token before any gh network command");

  // ── refuse collisions, then publish ──
  const existing = await capture([
    "gh",
    "release",
    "view",
    tag,
    "--repo",
    repo,
  ]);
  if (existing.code === 0) {
    fail(
      `release ${tag} already exists on ${repo} — bump "version" in ` +
        `desktop/tauri.conf.json (and Cargo.toml), rebuild, and publish again. ` +
        `Re-publishing a tag with different bytes would strand installed apps.`,
    );
  }
  // Build the asset upload list: desktop bundle + all headless target artifacts.
  const headlessAssets: string[] = [];
  for (const target of HEADLESS_TARGETS) {
    headlessAssets.push(join(bundleDir, target.asset), join(bundleDir, target.signature));
  }

  await run([
    "gh",
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--title",
    `Pantoken ${version}`,
    "--notes",
    `Bundled desktop release (shell + hub + client) from ${sha}.`,
    tar,
    sig,
    manifestPath,
    ...headlessAssets,
    join(bundleDir, "release-metadata.json"),
  ]);
  console.log(
    `\npublished ${tag}. Desktop apps poll ${endpoint}; headless targets: ${HEADLESS_TARGETS.map((t) => t.targetTriple).join(", ")}.`,
  );
}
