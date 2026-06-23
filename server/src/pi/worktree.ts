// Create/remove an isolated jj/git worktree of a repo directory, so a session can run
// on a clean copy of the tree (the new-session "worktree" toggle). Command/path planning
// is pure (unit-tested); only the create/remove/clean helpers touch disk + spawn the VCS.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomWorktreeName } from "./worktree-name.js";

const run = promisify(execFile);

export type Vcs = "jj" | "git";

/** A pilot-created worktree, recorded at creation so it can later be flagged in the
 *  sidebar and cleaned up. `path` is the worktree dir (== the session's cwd); `base`
 *  is the repo it was forked from; `name` is the jj workspace name (unused for git). */
export interface WorktreeMeta {
  readonly path: string;
  readonly base: string;
  readonly vcs: Vcs;
  readonly name: string;
}

/** Detect the VCS backing a directory. Prefers jj (the project's VCS) when a repo is
 *  colocated jj+git. Returns null when the dir isn't a recognized repo. */
export function detectVcs(repoDir: string): Vcs | null {
  if (existsSync(join(repoDir, ".jj"))) return "jj";
  if (existsSync(join(repoDir, ".git"))) return "git";
  return null;
}

/** Pure: plan the worktree path + the command to create it. Side-effect-free so it can
 *  be unit-tested without touching disk. The worktree is a sibling dir of the repo. */
export function planWorktree(
  repoDir: string,
  vcs: Vcs,
  id: string,
): {
  path: string;
  command: string;
  args: string[];
  name: string;
  base: string;
} {
  const base = resolve(repoDir).replace(/\/+$/, "");
  const name = `pilot-${id}`;
  const path = `${base}-${name}`;
  if (vcs === "jj")
    return {
      path,
      command: "jj",
      args: ["-R", base, "workspace", "add", "--name", name, path],
      name,
      base,
    };
  // git: a detached worktree at HEAD avoids inventing (and later colliding on) a branch.
  return {
    path,
    command: "git",
    args: ["-C", base, "worktree", "add", "--detach", path],
    name,
    base,
  };
}

/** Pure: plan how to tear a worktree down. `removeDir` is true when the VCS leaves the
 *  directory behind (jj `workspace forget` only stops tracking it) so the caller must
 *  rm it; git's `worktree remove` deletes the dir itself. Side-effect-free for testing. */
export function planWorktreeRemoval(
  meta: WorktreeMeta,
  force: boolean,
): { command: string; args: string[]; removeDir: boolean } {
  if (meta.vcs === "jj")
    return {
      command: "jj",
      args: ["-R", meta.base, "workspace", "forget", meta.name],
      removeDir: true,
    };
  return {
    command: "git",
    args: [
      "-C",
      meta.base,
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      meta.path,
    ],
    removeDir: false,
  };
}

/** Pick a worktree plan whose sibling dir doesn't already exist, using a memorable
 *  `adjective-animal` slug (re-rolled on the rare collision, then falling back to a
 *  timestamp so we never loop forever on a saturated wordlist). */
function planFreshWorktree(repoDir: string, vcs: Vcs) {
  for (let i = 0; i < 10; i++) {
    const plan = planWorktree(repoDir, vcs, randomWorktreeName());
    if (!existsSync(plan.path)) return plan;
  }
  return planWorktree(
    repoDir,
    vcs,
    `${randomWorktreeName()}-${Date.now().toString(36)}`,
  );
}

/** Create an isolated worktree of `repoDir` and return its metadata. Throws loudly if
 *  the dir isn't a jj/git repo or the VCS command fails — the caller surfaces it to the
 *  UI rather than silently falling back to the shared tree. With no explicit `id` the
 *  worktree gets a memorable `adjective-animal` slug; pass `id` for a deterministic name. */
export async function createWorktree(
  repoDir: string,
  id?: string,
): Promise<WorktreeMeta> {
  const vcs = detectVcs(repoDir);
  if (!vcs)
    throw new Error(
      `cannot create a worktree: ${repoDir} is not a jj or git repository`,
    );
  const { path, command, args, name, base } =
    id === undefined
      ? planFreshWorktree(repoDir, vcs)
      : planWorktree(repoDir, vcs, id);
  await run(command, args);
  return { path, base, vcs, name };
}

/** True if the worktree has no changes that removal would destroy. git: a clean
 *  `status --porcelain`. jj: no working-copy diff (jj auto-commits, so even "dirty"
 *  work is recoverable via the op log, but we still treat a non-empty diff as unsafe
 *  to silently reap). Returns false (unsafe) if the check itself errors — fail closed. */
export async function worktreeIsClean(meta: WorktreeMeta): Promise<boolean> {
  try {
    if (meta.vcs === "git") {
      const { stdout } = await run("git", [
        "-C",
        meta.path,
        "status",
        "--porcelain",
      ]);
      return stdout.trim() === "";
    }
    const { stdout } = await run("jj", ["diff", "--name-only"], {
      cwd: meta.path,
    });
    return stdout.trim() === "";
  } catch {
    return false;
  }
}

/** Remove a pilot-created worktree. With `force=false` this refuses a dirty worktree
 *  (returns {removed:false, reason}); with `force=true` it removes regardless, which
 *  can discard uncommitted git changes. Throws only on an unexpected VCS/fs failure. */
export async function removeWorktree(
  meta: WorktreeMeta,
  force = false,
): Promise<{ removed: boolean; reason?: string }> {
  if (!force && !(await worktreeIsClean(meta)))
    return { removed: false, reason: "worktree has uncommitted changes" };
  const plan = planWorktreeRemoval(meta, force);
  await run(plan.command, plan.args);
  if (plan.removeDir) await rm(meta.path, { recursive: true, force: true });
  return { removed: true };
}
