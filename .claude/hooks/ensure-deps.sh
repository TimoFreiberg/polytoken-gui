#!/usr/bin/env bash
# Provision dependencies when they're missing — chiefly a freshly created
# worktree, which starts without node_modules (it's gitignored). No-op when deps
# are already present (the main checkout, or an already-set-up worktree).
#
# Wired as a SessionStart hook in .claude/settings.json so it runs once when a
# session opens here, regardless of how the worktree was created. We use
# SessionStart rather than a project-level WorktreeCreate hook on purpose: a
# second WorktreeCreate hook would race the global one that does the actual
# `jj workspace add`, and ordering isn't guaranteed. SessionStart fires after the
# worktree exists, with cwd/CLAUDE_PROJECT_DIR pointing at it.
#
# All output goes to stderr: SessionStart hook stdout is injected into the
# session context, which we don't want polluted with install logs.

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -d node_modules ] && exit 0

BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
if [ -z "$BUN" ]; then
  echo "[pantoken] node_modules missing and bun not found on PATH — run 'bun install' yourself." >&2
  exit 0
fi

echo "[pantoken] node_modules missing — running 'bun install' (fresh worktree setup)…" >&2
"$BUN" install >&2 \
  || echo "[pantoken] bun install failed — run it manually before building/testing." >&2
exit 0
