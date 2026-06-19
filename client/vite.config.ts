import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { type Plugin, defineConfig } from "vite";

const SERVER = process.env.PILOT_SERVER ?? "http://localhost:8787";

// Stamp the build with the last commit's short hash + date, surfaced in the UI as an
// unobtrusive version string. Works in dev (the jj worktree resolves git) and in prod
// (the deploy slots are plain git clones). Falls back to "dev" if git isn't reachable
// rather than failing the build. `fullHash` is the un-abbreviated sha, written to a marker
// file (see stampBuiltSha) so the desktop update-watcher can tell when the *served* bundle
// has fallen behind HEAD — which short-hash display can't express and HEAD-only checks miss.
function gitInfo(): { hash: string; date: string; fullHash: string } {
  try {
    const git = (args: string): string =>
      execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    return {
      hash: git("rev-parse --short HEAD"),
      date: git("log -1 --format=%cd --date=short"),
      fullHash: git("rev-parse HEAD"),
    };
  } catch {
    return { hash: "dev", date: "", fullHash: "" };
  }
}
const BUILD = gitInfo();

// Write the built commit's full sha into <outDir>/.pilot-built-sha after a production
// build. The desktop update-watcher reads this — NOT git HEAD — to decide whether the
// running app is current: HEAD can advance without a rebuild (a manual `git pull`, an
// apply interrupted before its build, a build that failed after the pull), and only the
// stamped bundle sha reveals that the user is still looking at stale code. Build-only and
// best-effort: a missing marker just costs one extra rebuild on the watcher's first tick.
function stampBuiltSha(fullHash: string): Plugin {
  let root = process.cwd();
  let outDir = "dist";
  return {
    name: "pilot-build-sha-stamp",
    apply: "build",
    configResolved(c) {
      root = c.root;
      outDir = c.build.outDir;
    },
    closeBundle() {
      if (!fullHash) return; // git unreachable at build time — skip rather than stamp junk
      try {
        writeFileSync(resolve(root, outDir, ".pilot-built-sha"), fullHash);
      } catch {
        // best-effort — never fail a build over the marker
      }
    },
  };
}

// During dev the Svelte app runs on Vite (5173) and proxies the WS + introspection
// endpoints to the Bun server (8787). In prod the Bun server serves the built bundle.
export default defineConfig({
  plugins: [svelte(), stampBuiltSha(BUILD.fullHash)],
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD.hash),
    __BUILD_DATE__: JSON.stringify(BUILD.date),
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: SERVER, ws: true },
      "/debug": { target: SERVER },
      "/health": { target: SERVER },
      "/push": { target: SERVER },
      "/update": { target: SERVER },
    },
  },
});
