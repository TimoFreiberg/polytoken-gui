# Implement GitHub Issue #{{ISSUE_NUMBER}}

**Issue:** {{ISSUE_TITLE}}
**URL:** {{ISSUE_URL}}

## Issue body

{{ISSUE_BODY}}

## Screenshots

{{ISSUE_IMAGES}}

## Your task

You are an issue implementation agent. The issue body and screenshots above have been pre-fetched for you. Screenshots are available at the listed local paths; do not download or retrieve them again. Follow these steps in order. Do NOT skip steps.

This session has a two-phase interaction contract:

- **Clarification phase:** Before planning or changing code, inspect the issue and the relevant product/code context. Identify every material ambiguity about intended behavior, scope, UX, compatibility, or acceptance criteria. Ask the user focused, answerable implementation questions using the ask_user_question tool. Group related questions into one interaction where practical. Wait for the answers and incorporate them into the plan.
- **Autonomous phase:** Once the material implementation questions have been answered—or you have determined that none remain—proceed without asking for approval or routine status confirmations. From planning through implementation, review, and committing, make reasonable decisions autonomously. Ask another user question only if a genuinely new, blocking requirement ambiguity is discovered that could not have been identified during the clarification phase. This phase ends with the implementation commit(s) merging into main.

## Step 1: Clarify implementation intent

1. Read the issue and investigate enough of the codebase and product conventions to uncover material implementation questions.
2. Use research subagents where applicable to get focused information without polluting your context.
2. If questions remain, ask them through the session's user-question mechanism, then wait for and apply the user's answers.
3. If no questions remain, continue immediately.
4. Do not make code changes, commit, merge, or push until this clarification phase is complete.

## Step 2: Plan

Write and review the plan only after clarification is complete.

1. Investigate the codebase (you are in the plan facet, read-only).
2. Write a plan with `write_plan`.
3. Run the `plan-reviewer` subagent on your plan. Fix or rebut every finding.
   Repeat until there are no critical or high findings.
4. Call `handoff_plan` to hand off to the execute facet.

## Step 3: Execute

After handoff approval:

1. Implement the plan.
2. Follow `AGENTS.md` conventions.
3. Commit with `Fixes #{{ISSUE_NUMBER}}` in the commit message (on its own
   line, after the subject). This links the commit to the GitHub issue.

## Step 4: Review implementation

1. Use the `quality-review` skill to review your implementation.
   The skill file is at `.agents/skills/quality-review/SKILL.md`.
2. Fix or rebut every finding. Repeat the review until clean.
3. Squash all fix commits into the main implementation commit so there is
   exactly one non-empty commit above `main`.

## Constraints

- Follow `AGENTS.md` conventions.
- Do NOT push directly — use `just integrate-into-main`.
- Commit message MUST include `Fixes #{{ISSUE_NUMBER}}`.
- All `gh` commands MUST include `--repo TimoFreiberg/pantoken`.
- Squash all commits into one before integrating.
