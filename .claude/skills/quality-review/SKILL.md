---
description: >-
  Project-specific quality-gate review for the pantoken repo. Runs the global
  review-subagent skill (correctness, security, design, docs, tests) AND a
  separate quality-invariant pass that checks the diff against QUALITY.md.
  Use when asked to review changes, run a quality gate, or verify a diff
  respects pantoken product invariants.
---

# quality-review — pantoken quality-gate review

This is a **project-specific wrapper** around the global `review-subagent`
skill. It does two things:

1. **Delegates the standard review** (correctness, security, design,
   documentation, tests) to the global `review-subagent` skill — unchanged.
   Those axes are not duplicated here.
2. **Adds a quality-invariant pass** that checks the diff against
   `QUALITY.md` — the stable product invariants specific to pantoken that the
   global reviewer has no knowledge of.

The quality pass is a **separate reviewer**, not an injection into the existing
reviewer prompts. This keeps the global reviewers focused on their axes and
makes quality-gate findings easy to distinguish.

## When to use

Run this skill when reviewing any diff in the pantoken repo — uncommitted
changes, a branch, a commit, or a PR. It is the project-specific complement to
the global review.

## Step 1: Run the global review

Invoke the `review-subagent` skill with the same `$ARGUMENTS` you received.
Follow its instructions exactly — it will spawn the C+S and D+T reviewer
subagents and surface their reports verbatim. Do not modify its behavior.

Surface the global review reports first, under their standard headers, before
running the quality pass.

## Step 2: Gather scope for the quality pass

The quality pass needs the same diff the global reviewers saw. Reuse the scope
artifacts produced by `scope.py` from Step 2 of the global skill — specifically
the `diff` file path. Do not re-run `scope.py`; the global skill already ran it
and printed the temp dir.

If you are running this skill standalone (not after the global skill), run
`scope.py` yourself:

```
uv run $HOME/dotfiles/agents/skills/review-subagent/scope.py [<subcommand> [<arg>]]
```

Keep the `diff` file path for the quality reviewer prompt.

## Step 3: Determine applicable quality criteria

Read `QUALITY.md` and determine which criteria apply to the diff based on the
files touched. Each criterion in `QUALITY.md` carries applicability tags:

- `[UI]` — applies when `client/` files are in the diff (Svelte, CSS, DOM).
- `[server]` — applies when `server-rs/` files are in the diff (Rust).
- `[proto]` — applies when `protocol/` files are in the diff.
- `[cross]` — applies regardless of which layer changed.

Only check the criteria whose tags match the diff. A CSS-only change must not
be judged against `[server]` criteria like "no `unsafe`" or "avoid unnecessary
clones." A server-only change must not be judged against `[UI]` criteria like
"hotkeys and tooltips."

Record the applicable criterion IDs (Q1–Q21) so the reviewer can report
against them explicitly.

## Step 4: Spawn the quality reviewer

Spawn one `general-purpose` subagent with this prompt (fill `$DIFF_PATH` and
`$APPLICABLE_CRITERIA`):

```
You are a quality-gate reviewer for the pantoken repo. Your job is to check
the diff against the project-specific product invariants in QUALITY.md.

First, Read QUALITY.md at the repo root. Then read the diff file at:

$DIFF_PATH

Only check the criteria that are applicable to this diff. The applicable
criteria are:

$APPLICABLE_CRITERIA

For each applicable criterion, determine whether the diff satisfies it. Report
findings using the CONTRACT.md severity format from the global review (B/M/S).
Prefix each finding with "Q" and the criterion number (e.g. "Q3-B: the composer
draft is not persisted on navigation").

Also check:
- Whether the change introduces a new code path that an existing automated
  test does not cover, where that test would be the primary guard for a
  quality criterion. Report as "Q<n>-T: <criterion> lacks test coverage for
  <path>".
- Whether the diff touches an area with an open "discussion needed" item in
  docs/TODO.md. If so, note it as "Q-discuss: <item>" — do not block, just
  flag that an open product decision is relevant.

If no quality criteria are applicable (e.g., a docs-only change), report
"# Quality Review — no applicable criteria" and stop.

Begin your report with:
# Quality Review

## Applicable criteria
<list>

## Findings
<findings, or "none" if all criteria satisfied>
```

## Step 5: Surface all reports

Print the global review reports (from Step 1) verbatim, then the quality
review report verbatim, under its own header:

    ## Reviewer: C+S

    <global C+S report>

    ## Reviewer: D+T

    <global D+T report>

    ## Reviewer: Quality

    <quality reviewer report>

Do not add commentary or merge findings across the three reports. The
consumer decides what to act on.

## Looping

When used as an adversarial gate during implementation, loop:
implement → commit → review → fix → repeat. Commit between rounds so each
reviewer sees the cumulative diff at a definite state. Keep going until both
the global review and the quality pass are clean. If you keep looping on the
same issue without converging, stop and escalate to the operator with the
outstanding findings.
