#!/usr/bin/env bun
// publish.ts — build and publish a desktop release (the bundled .app: shell + compiled
// hub + client) plus the static updater manifest the running apps poll.
//
//   bun scripts/desktop/publish.ts --repo <owner/name> [--dry-run] [--skip-build]
//
// The repo is a GitHub RELEASES repo (public: installed apps download from it without
// credentials) — it does NOT have to be the code remote. Override via
// PILOT_RELEASE_REPO instead of --repo if you prefer env config.
//
// Safety properties, learned from the spike (docs/ADR-desktop-shell.md):
// - **latest.json's `version` is read from the BUILT bundle's Info.plist**, never from
//   config: a manifest version that outruns the artifact makes every relaunch "update"
//   again — an infinite install loop under the unattended policy.
// - Refuses to overwrite an existing release tag: bump `version` in
//   desktop-tauri/tauri.conf.json (keep Cargo.toml in step) and rebuild instead.
// - Signing key comes from TAURI_SIGNING_PRIVATE_KEY or ~/.tauri/pilot-shell.key —
//   missing key fails BEFORE the (multi-minute) build, not after.
//
// Apps consume releases via the stable endpoint
//   https://github.com/<owner/name>/releases/latest/download/latest.json
// (each release carries its own latest.json asset; GitHub's `latest` alias serves the
// newest release's copy). Put that URL in PILOT_SHELL_UPDATE_URL or the data dir's
// `shell-update-url` file — see desktop-tauri/README.md "Updates".

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const bundleDir = join(
  repoRoot,
  "desktop-tauri",
  "target",
  "release",
  "bundle",
  "macos",
);

function fail(msg: string): never {
  console.error(`publish: ${msg}`);
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
} {
  const dryRun = argv.includes("--dry-run");
  const skipBuild = argv.includes("--skip-build");
  const flagIdx = argv.indexOf("--repo");
  const repo =
    (flagIdx >= 0 ? argv[flagIdx + 1] : undefined) ??
    process.env.PILOT_RELEASE_REPO ??
    "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    fail(
      "no release repo. Pass --repo <owner/name> or set PILOT_RELEASE_REPO — the " +
        "public GitHub repo that hosts release artifacts (not necessarily the code remote).",
    );
  }
  return { repo, dryRun, skipBuild };
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
  const keyfile = join(homedir(), ".tauri", "pilot-shell.key");
  if (!existsSync(keyfile)) {
    fail(
      `no updater signing key: set TAURI_SIGNING_PRIVATE_KEY or create ${keyfile} ` +
        `(bunx tauri signer generate -w ${keyfile}) — without it the build can't ` +
        `produce updater artifacts`,
    );
  }
  return {
    TAURI_SIGNING_PRIVATE_KEY: keyfile, // the plugin accepts a path or the key text
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  };
}

if (import.meta.main) {
  const { repo, dryRun, skipBuild } = parseArgs(process.argv.slice(2));

  // ── preflight ──
  const gh = await capture(["gh", "auth", "status"]);
  if (gh.code !== 0 && !dryRun) {
    fail(
      `\`gh auth status\` failed — install GitHub CLI and run \`gh auth login\`.\n${gh.stderr}`,
    );
  }
  const sign = signingEnv();

  // ── build (signed, updater artifacts included) ──
  if (!skipBuild) {
    await run(["bun", "run", "build"], {
      cwd: join(repoRoot, "desktop-tauri"),
      env: sign,
    });
  }

  // ── locate + validate artifacts ──
  const app = join(bundleDir, "Pilot.app");
  const tar = join(bundleDir, "Pilot.app.tar.gz");
  const sig = `${tar}.sig`;
  for (const p of [app, tar, sig]) {
    if (!existsSync(p))
      fail(
        `expected artifact missing: ${p} (did the build produce updater artifacts?)`,
      );
  }

  // The version OF THE ARTIFACT — from the built plist, not from any config file.
  const plist = await capture([
    "plutil",
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    join(app, "Contents", "Info.plist"),
  ]);
  if (plist.code !== 0) fail(`couldn't read bundle version: ${plist.stderr}`);
  const version = plist.stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(version))
    fail(`implausible bundle version '${version}'`);
  const tag = `v${version}`;

  // ── compose latest.json ──
  const signature = (await Bun.file(sig).text()).trim();
  const manifest = {
    version,
    pub_date: new Date().toISOString(),
    platforms: {
      [platformKey()]: {
        url: `https://github.com/${repo}/releases/download/${tag}/Pilot.app.tar.gz`,
        signature,
      },
    },
  };
  const manifestPath = join(bundleDir, "latest.json");
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const head = await capture(["git", "-C", repoRoot, "rev-parse", "HEAD"]);
  const sha = head.code === 0 ? head.stdout.trim().slice(0, 12) : "unknown";
  const endpoint = `https://github.com/${repo}/releases/latest/download/latest.json`;

  console.log(`\nrelease ${tag} → ${repo}`);
  console.log(`  bundle:   ${tar}`);
  console.log(`  manifest: ${manifestPath}`);
  console.log(`  commit:   ${sha}`);
  console.log(`  endpoint: ${endpoint}\n`);

  if (dryRun) {
    console.log("[dry-run] would `gh release create` with the assets above");
    process.exit(0);
  }

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
        `desktop-tauri/tauri.conf.json (and Cargo.toml), rebuild, and publish again. ` +
        `Re-publishing a tag with different bytes would strand installed apps.`,
    );
  }
  await run([
    "gh",
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--title",
    `Pilot ${version}`,
    "--notes",
    `Bundled desktop release (shell + hub + client) from ${sha}.`,
    tar,
    sig,
    manifestPath,
  ]);
  console.log(
    `\npublished ${tag}. Running apps poll ${endpoint} and update within a minute.`,
  );
}
