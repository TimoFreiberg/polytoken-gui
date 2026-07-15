# Implement GitHub Issue #{{ISSUE_NUMBER}}

**Issue:** {{ISSUE_TITLE}}
**URL:** {{ISSUE_URL}}

## Your task

You are an autonomous agent implementing a GitHub issue. Follow these steps
in order. Do NOT skip steps.

## Step 1: Read the issue

Read the issue with:

```
gh issue view {{ISSUE_NUMBER}} --repo TimoFreiberg/pantoken
```

All `gh` commands MUST include `--repo TimoFreiberg/pantoken` — this workspace
is a jj workspace without a `.git` directory, so `gh` cannot auto-detect the repo.

## Step 2: Evaluate implementability

If the issue is ambiguous or you cannot implement it without a human answer:

1. Post a comment on the GitHub issue:
   ```
   gh issue comment {{ISSUE_NUMBER}} --repo TimoFreiberg/pantoken --body "..."
   ```
   - The comment body MUST start with `<!-- autopilot -->` on its own line,
     then a blank line, then your question.
   - Ask one specific, answerable question.
2. Do NOT commit or make any code changes.
3. Stop. The outer script will handle cleanup.

## Step 3: Plan

If the issue is implementable:

1. Investigate the codebase (you are in the plan facet, read-only).
2. Write a plan with `write_plan`.
3. Run the `plan-reviewer` subagent on your plan. Fix or rebut every finding.
   Repeat until there are no critical or high findings.
4. Call `handoff_plan` to hand off to the execute facet.

## Step 4: Execute

After handoff approval:

1. Implement the plan.
2. Follow `AGENTS.md` conventions.
3. Commit with `Fixes #{{ISSUE_NUMBER}}` in the commit message (on its own
   line, after the subject). This links the commit to the GitHub issue.

## Step 5: Review implementation

1. Use the `quality-review` skill to review your implementation.
   The skill file is at `.agents/skills/quality-review/SKILL.md`.
2. Fix or rebut every finding. Repeat the review until clean.
3. Squash all fix commits into the main implementation commit so there is
   exactly one non-empty commit above `main`.

## Step 6: Integrate

Run the integration command from the workspace root directory:

```
just integrate-into-main {{ISSUE_NUMBER}}
```

This acquires a repo-local lock, fetches latest main, rebases your commits
onto `main@origin`, runs tests (`bun test` + `bun run check` + `cargo fmt`),
advances the main bookmark, and pushes.

**Exit codes:**
- **0** (success): integration complete. You are done — stop.
- **2** (conflicts): the rebase produced conflicts. The lock is still held
  by your session. Use the `jj-resolve-conflicts` skill to resolve conflicts
  in the workspace, then call `just integrate-into-main {{ISSUE_NUMBER}}`
  again. Repeat until success.
- **1** (error): investigate the error, fix it, and retry. If the error is
  unrecoverable, post a comment on the issue explaining what went wrong and
  stop.

**Important:** `just integrate-into-main` fully blocks while waiting for the
lock (another agent may be integrating). If the bash call times out (agent
shell timeout), just call it again — the lock is a file (`.merge-lock`)
keyed by PID + session_id, not an flock. Same-session re-acquisition is
immediate.

## Step 7: Done

After successful integration, you can stop. The outer script cleans up the
workspace automatically.

## Constraints

- Follow `AGENTS.md` conventions.
- Do NOT push directly — use `just integrate-into-main`.
- Commit message MUST include `Fixes #{{ISSUE_NUMBER}}`.
- All `gh` commands MUST include `--repo TimoFreiberg/pantoken`.
- Squash all commits into one before integrating.
