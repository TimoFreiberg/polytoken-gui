#!/usr/bin/env bun
// release.ts — cut a release: bump the version, commit, tag, push. CI does the rest
// (the tag push triggers ci.yml's release job, which builds signed and publishes via
// publish.ts once the test jobs pass).
//
//   bun scripts/desktop/release.ts [--patch|--minor|--major|--version X.Y.Z]
//                                  [--dry-run] [--no-push]
//
// Default bump: --patch. What it does, in order:
//   1. refuse a dirty working copy (the release commit must contain ONLY the bump)
//   2. bump "version" in desktop/tauri.conf.json + Cargo.toml, sync Cargo.lock
//   3. jj commit those three files ("Release vX.Y.Z")
//   4. git tag vX.Y.Z on that commit (jj can't create tags; the colocated .git can)
//   5. move the `main` bookmark to the release commit, `jj git push`, push the tag
//
// --no-push stops after step 4 and prints the push commands. --dry-run only prints
// what would happen. Requires a colocated jj+git checkout (this repo is one).

import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const confPath = join(repoRoot, "desktop", "tauri.conf.json");
const cargoPath = join(repoRoot, "desktop", "Cargo.toml");

function fail(msg: string): never {
  console.error(`release: ${msg}`);
  process.exit(1);
}

async function capture(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: cwd ?? repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0)
    fail(`\`${cmd.join(" ")}\` failed:\n${stderr.trim() || stdout.trim()}`);
  return stdout;
}

export function bumpVersion(
  current: string,
  kind: "patch" | "minor" | "major",
): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`unparseable version '${current}'`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const noPush = argv.includes("--no-push");
  const vIdx = argv.indexOf("--version");

  const conf = (await Bun.file(confPath).json()) as { version?: string };
  const current = conf.version ?? "";
  const next =
    vIdx >= 0
      ? (argv[vIdx + 1] ?? fail("--version needs a value"))
      : bumpVersion(
          current,
          argv.includes("--major")
            ? "major"
            : argv.includes("--minor")
              ? "minor"
              : "patch",
        );
  if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`implausible version '${next}'`);
  const tag = `v${next}`;

  // Working copy must be clean: the release commit is the bump and nothing else.
  const dirty = (await capture(["jj", "diff", "--summary"])).trim();
  if (dirty) {
    fail(
      `working copy is not empty — commit or abandon first:\n${dirty}\n` +
        `(the release commit must contain only the version bump)`,
    );
  }
  if ((await capture(["git", "tag", "-l", tag])).trim()) {
    fail(`tag ${tag} already exists locally — bump differently or delete it`);
  }

  console.log(`release: ${current} → ${next} (tag ${tag})`);
  if (dryRun) {
    console.log("[dry-run] would bump, commit, tag, move main, push");
    process.exit(0);
  }

  // ── bump ──
  const confText = await Bun.file(confPath).text();
  const confNeedle = `"version": "${current}"`;
  if (!confText.includes(confNeedle))
    fail(`couldn't find ${confNeedle} in tauri.conf.json`);
  await Bun.write(
    confPath,
    confText.replace(confNeedle, `"version": "${next}"`),
  );

  const cargoText = await Bun.file(cargoPath).text();
  const cargoNeedle = `version = "${current}"`;
  if (!cargoText.includes(cargoNeedle))
    fail(`couldn't find ${cargoNeedle} in Cargo.toml`);
  await Bun.write(
    cargoPath,
    cargoText.replace(cargoNeedle, `version = "${next}"`),
  );

  // Sync the lockfile's own-package entry (cargo check would too, but this is fast
  // and touches nothing else).
  await capture(
    ["cargo", "update", "--workspace"],
    join(repoRoot, "desktop"),
  );

  // ── commit + tag ──
  // The subject "Release vX.Y.Z" is LOAD-BEARING: ci.yml skips the branch-push run
  // for commits with this prefix (the tag push runs the full pipeline instead, so a
  // release costs one CI run, not two). Change it there if you change it here.
  await capture([
    "jj",
    "commit",
    "desktop/tauri.conf.json",
    "desktop/Cargo.toml",
    "desktop/Cargo.lock",
    "-m",
    `Release ${tag}`,
  ]);
  const commit = (
    await capture(["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"])
  ).trim();
  await capture(["git", "tag", tag, commit]);
  console.log(`committed + tagged ${tag} at ${commit.slice(0, 12)}`);

  // ── push ──
  if (noPush) {
    console.log(
      `--no-push: when ready →\n` +
        `  jj bookmark move main --to ${commit.slice(0, 12)}\n` +
        `  jj git push --bookmark main\n  git push origin ${tag}`,
    );
    process.exit(0);
  }
  await capture(["jj", "bookmark", "move", "main", "--to", commit]);
  await capture(["jj", "git", "push", "--bookmark", "main"]);
  await capture(["git", "push", "origin", tag]);

  const origin = (await capture(["git", "remote", "get-url", "origin"])).trim();
  const repo = origin.match(/github\.com[:/](.+?)(\.git)?$/)?.[1];
  console.log(
    `pushed main + ${tag}. CI runs tests, then the release job publishes.\n` +
      (repo ? `watch: https://github.com/${repo}/actions` : ""),
  );
}
