#!/usr/bin/env bun
// build-hub.ts — compile the Rust pantoken server into a binary for the bundled
// desktop app.
//
// The output lands in desktop/binaries/pantoken-server-<target-triple> — the
// target-triple suffix is Tauri's externalBin convention (the bundler strips it
// and ships the binary as Contents/MacOS/pantoken-server). At runtime the binary
// only needs the external tools the hub always shelled out to (polytoken,
// git/jj, fd) plus PANTOKEN_CLIENT_DIST pointing at a built client bundle (in the
// .app: the client-dist resource).
//
// Run from anywhere: `bun scripts/desktop/build-hub.ts`. Used as the Tauri
// beforeDevCommand/beforeBuildCommand (desktop/tauri.conf.json) — dev
// needs the file to exist because tauri-build stages externalBin next to the
// dev binary and errors when it's missing, even though dev never spawns it.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

/** Rust-style target triple for the host, matching what `tauri build` expects
 *  for externalBin lookup. Extend when a new host platform actually ships. */
export function hostTriple(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const map: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "linux-x64": "x86_64-unknown-linux-gnu",
  };
  const triple = map[`${platform}-${arch}`];
  if (!triple) {
    throw new Error(
      `no target triple mapping for ${platform}-${arch} — add one to build-hub.ts`,
    );
  }
  return triple;
}

if (import.meta.main) {
  const outDir = join(repoRoot, "desktop", "binaries");
  mkdirSync(outDir, { recursive: true });
  // tauri.conf.json maps ../client/dist as a bundle resource; guarantee the dir
  // exists so a fresh checkout can `tauri dev` before any client build.
  mkdirSync(join(repoRoot, "client", "dist"), { recursive: true });

  // Build the Rust server in release mode for the host target.
  const build = Bun.spawn(
    ["cargo", "build", "--release", "--bin", "pantoken-server"],
    { cwd: join(repoRoot, "server-rs"), stdout: "inherit", stderr: "inherit" },
  );
  const code = await build.exited;
  if (code !== 0) process.exit(code);

  const triple = hostTriple();
  const built = join(
    repoRoot,
    "server-rs",
    "target",
    "release",
    "pantoken-server",
  );
  const outfile = join(outDir, `pantoken-server-${triple}`);
  if (!existsSync(built)) {
    console.error(`cargo build succeeded but ${built} is missing`);
    process.exit(1);
  }
  copyFileSync(built, outfile);

  const size = (Bun.file(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`server compiled → ${outfile} (${size} MB)`);
}
