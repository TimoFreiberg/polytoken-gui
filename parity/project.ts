// parity/project.ts — create/reset the isolated test project.
//
// The project is the session cwd shared by the GUI and the TUI. It's a git repo (so
// VCS-aware features — trust, worktrees — have a repo to work in) and lives OUTSIDE the
// pilot checkout (under PARITY_ROOT) so a driven session never nests in or mutates pilot.

import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureEnv, paths, type Paths } from "./lib.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "project");

/** Recreate $PARITY_ROOT/project from the fixture and git-init + commit once. Destructive:
 *  wipes any existing project dir first (it's a throwaway). */
export async function resetProject(p: Paths = paths()): Promise<string> {
  ensureEnv(p);
  rmSync(p.project, { recursive: true, force: true });
  cpSync(FIXTURE, p.project, { recursive: true });
  // git init + a single commit so trust/worktree code sees a real repo.
  const run = async (cmd: string[]) => {
    const proc = Bun.spawn({
      cmd,
      cwd: p.project,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "parity",
        GIT_AUTHOR_EMAIL: "parity@localhost",
        GIT_COMMITTER_NAME: "parity",
        GIT_COMMITTER_EMAIL: "parity@localhost",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(
        `${cmd.join(" ")} failed (${code}): ${err.slice(0, 300)}`,
      );
    }
  };
  await run(["git", "init", "-q", "-b", "main"]);
  await run(["git", "add", "-A"]);
  await run(["git", "commit", "-q", "-m", "parity test project (seed)"]);
  return p.project;
}

/** Ensure the project AND the isolated env (dirs + generated config) exist; reset the
 *  project only if missing. ensureEnv runs unconditionally so the config.yaml is present
 *  even when the project dir already exists. */
export async function ensureProject(p: Paths = paths()): Promise<string> {
  ensureEnv(p);
  if (!existsSync(join(p.project, ".git"))) return resetProject(p);
  return p.project;
}

// CLI: `bun parity/project.ts reset|path|ensure`
if (import.meta.main) {
  const cmd = process.argv[2] ?? "ensure";
  const p = paths();
  if (cmd === "path") {
    console.log(p.project);
  } else if (cmd === "reset") {
    console.log(await resetProject(p));
  } else if (cmd === "ensure") {
    console.log(await ensureProject(p));
  } else {
    console.error(`usage: project.ts <reset|path|ensure>`);
    process.exit(1);
  }
}
