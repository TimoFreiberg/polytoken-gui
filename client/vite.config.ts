import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { type Plugin, defineConfig } from "vite";

const SERVER = process.env.PILOT_SERVER ?? "http://localhost:8787";

// Stamp the build with the last commit's short hash + date, surfaced in the UI as an
// unobtrusive version string. Resolves via git in a normal checkout (and the deploy
// slots, which are plain git clones); falls back to jj for a pure jj workspace/worktree
// that has no colocated `.git` (where `git rev-parse` throws "not a git repository") —
// running tests from such a worktree is routine, and a meaningful stamp beats "dev".
// Falls back to "dev" only if neither VCS is reachable, rather than failing the build.
// `fullHash` is the un-abbreviated sha, written to a marker file (see stampBuiltSha) so
// the desktop update-watcher can tell when the *served* bundle has fallen behind HEAD —
// which short-hash display can't express and HEAD-only checks miss.
function run(cmd: string): string {
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}
function gitInfo(): { hash: string; date: string; fullHash: string } {
  try {
    return {
      hash: run("git rev-parse --short HEAD"),
      date: run("git log -1 --format=%cd --date=short"),
      fullHash: run("git rev-parse HEAD"),
    };
  } catch {
    // No reachable git — try jj. `@-` is the working copy's parent, i.e. the last
    // committed revision, the same thing `git HEAD` points at in a colocated repo.
    try {
      const jj = (template: string): string =>
        run(`jj log --no-graph --color=never -r @- -T '${template}'`);
      return {
        hash: jj("commit_id.short(9)"),
        date: jj('committer.timestamp().format("%Y-%m-%d")'),
        fullHash: jj("commit_id"),
      };
    } catch {
      return { hash: "dev", date: "", fullHash: "" };
    }
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
    // Full sha, compared against hello.buildSha (the sha of the bundle the
    // server is SERVING) to detect that the server updated underneath a
    // long-lived tab/PWA. Matches the .pilot-built-sha marker by construction.
    __BUILD_FULL_HASH__: JSON.stringify(BUILD.fullHash),
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
