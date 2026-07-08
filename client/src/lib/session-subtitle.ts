/** The header subtitle's "where am I" line under the session title: the project
 *  name (basename of the session cwd), plus the worktree directory when the
 *  session runs in a pantoken-created worktree — there its cwd is the worktree and
 *  `worktreeBase` is the repo it forked from, so we show `project · worktree` to
 *  flag that it's a different checkout. Pure + DOM-free so it's unit-testable; the
 *  component feeds it the active session's list entry (the folded snapshot doesn't
 *  carry cwd/worktree). */
export function sessionSubtitle(opts: {
  cwd?: string;
  worktreeBase?: string;
}): string {
  const cwd = opts.cwd ?? "";
  if (!cwd) return "no session";
  const project = basename(opts.worktreeBase ?? cwd);
  const worktreeDir = opts.worktreeBase ? basename(cwd) : "";
  // Drop the suffix when it would just repeat the project (degenerate worktree).
  return worktreeDir && worktreeDir !== project
    ? `${project} · ${worktreeDir}`
    : project;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
