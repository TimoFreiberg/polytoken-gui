# Pantoken Scripts

Per-issue autonomous implementation and integration tooling.

## Quick start

```bash
# Implement a GitHub issue (spawns a TUI agent in a new zellij tab):
just implement-issue https://github.com/TimoFreiberg/pantoken/issues/42

# Or by number:
just implement-issue 42
```

## How it works

1. **`just implement-issue <url>`** → `scripts/implement-issue.sh`
   - Creates a jj workspace (`pantoken-issue-<N>`)
   - Spawns a headless polytoken daemon
   - Seeds it via HTTP: bypass_plus permissions, plan facet, adventurous
     handoff, goal, and the seed prompt
   - Opens a zellij tab with the TUI (blocks until TUI closes)
   - After TUI closes: checks if integration succeeded, cleans up workspace

2. **The agent** (inside the TUI) runs autonomously:
   - Reads the issue via `gh`
   - Plans → plan-reviewer review → handoff
   - Executes → implements → commits (with `Fixes #N`)
   - Reviews via `quality-review` skill → fixes → squashes
   - Calls `just integrate-into-main <N>`

3. **`just integrate-into-main <N>`** → `scripts/integrate-into-main.sh`
   - Acquires a repo-local lock (`.merge-lock`, file-based with PID liveness)
   - Fetches latest main, rebases `main..@` onto `main@origin`
   - Runs `bun test` + `bun run check` + `cargo fmt`
   - Advances the main bookmark, pushes
   - On conflict: exits 2 (lock held), agent resolves and retries
   - Exit codes: 0=success, 2=conflicts, 1=error

## Lock model

The `.merge-lock` file at the repo root serializes integration across
concurrent agents. It's a JSON file with `{pid, session_id, issue_number,
timestamp}`. The lock survives process death (agent shell timeouts) because
it's a file, not an flock.

- **PID alive**: block and wait
- **PID dead, same session**: immediate re-acquire (retry after conflict)
- **PID dead, different session, < 30 min old**: block (likely resolving conflicts)
- **PID dead, different session, ≥ 30 min old**: steal (stale lock)

Manual override: `rm .merge-lock`

## Files

```
justfile                          — entry points (implement-issue, integrate-into-main)
scripts/
  implement-issue.sh              — per-issue launcher (workspace, daemon, seed, zellij)
  seed-session.sh                 — HTTP seeds a headless daemon (facet, permissions, handoff, goal, prompt)
  seed-prompt.md                  — the agent's initial prompt template
  integrate-into-main.sh          — jj linearize + push (lock, fetch, rebase, test, bookmark, push)
  claims.sh                       — issue claim/release/stale-recovery
  README.md                       — this file
  test/
    integrate-into-main.test.ts   — jj primitive + lock logic tests
    claims.test.ts                — claim management tests
```

## Dependencies

- `polytoken` (0.5.0+) — the agent harness
- `jj` — version control
- `gh` — GitHub CLI (authenticated as `TimoFreiberg`)
- `jq` — JSON processing
- `zellij` — terminal multiplexer (for TUI tab management)
- `curl` — HTTP requests to the daemon
- `just` — command runner
