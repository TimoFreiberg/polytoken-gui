#!/usr/bin/env bash
# finalize.sh — linearize jj history onto main and push.
#
# Called from the main loop after the TUI closes. Must be run from inside
# the implementer's jj workspace (the workspace that has the new commits).
#
# Steps:
#   1. Fetch latest main (another implementer or manual work may have pushed)
#   2. Capture pre-rebase op ID for conflict recovery
#   3. Rebase only new commits (main..@) onto main@origin
#   4. Check for conflicts — if found, spawn agent to resolve; if unresolvable,
#      roll back, post issue comment, exit 1
#   5. Advance main bookmark to our tip
#   6. Push to origin
#   7. Close the GitHub issue with a comment linking the pushed commit
#
# Usage: finalize.sh <issue_number>
set -euo pipefail

ISSUE_NUMBER="${1:?usage: finalize.sh <issue_number>}"

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

WORKSPACE_NAME="autopilot-$ISSUE_NUMBER"

# Post a conflict-escalation comment on the GitHub issue.
_post_conflict_comment() {
  local issue=$1 ws=$2
  local diff_summary
  diff_summary=$(jj diff --summary 2>/dev/null || echo "unable to generate diff summary")
  gh issue comment "$issue" --repo TimoFreiberg/pantoken --body "$(cat <<EOF
<!-- autopilot -->

Implementation complete but push failed: rebase conflict with concurrent work
that the automated resolver could not merge. Manual resolution needed.
The work is in workspace \`$ws\` at \`../pantoken-autopilot-$issue\`.

\`\`\`
$diff_summary
\`\`\`
EOF
)" || true
}

# 1. Fetch latest main (another implementer or manual work may have pushed)
jj git fetch

# 2. Capture pre-rebase op ID for conflict recovery
PRE_REBASE_OP=$(jj op log --limit 1 --no-graph -T id)

# 3. Rebase only our new commits onto latest main.
# "main..@" = commits reachable from @ but not from main — only the
# implementation work, NOT the entire history.
# NOTE: jj rebase exits 0 even when it produces conflicts — conflicts are
# a first-class state, not an error. We must check for conflicts AFTER.
# Guard: if main..@ is empty (no new commits), skip rebase — nothing to push.
NEW_COMMITS=$(jj log -r 'main..@' --no-graph -T 'commit_id' 2>/dev/null | head -1)
if [ -z "$NEW_COMMITS" ]; then
  log "WARN: no new commits to push (main..@ is empty) — skipping"
  exit 0
fi
jj rebase -s 'main..@' -d main@origin 2>/dev/null || true

# 4. Check for conflicts unconditionally (jj rebase exits 0 even on conflict)
CONFLICTS=$(jj resolve --list 2>/dev/null | head -1 || true)
if [ -n "$CONFLICTS" ]; then
  log "Rebase conflict detected — spawning agent to resolve"

  # Spawn a headless agent with the jj-resolve-conflicts skill.
  # The agent resolves conflicts by editing markers directly, then squashing.
  # If it can't resolve (contradictory changes), it escalates by returning
  # non-zero, and we fall back to rollback + issue comment.
  RESOLVE_PROMPT="You are in a jj workspace at $(pwd). A rebase produced conflicts.
Use the jj-resolve-conflicts skill to resolve them.
Resolve all conflicts by understanding both sides and editing the files directly.
After resolving, verify with 'jj st' and squash the resolution.
If the conflicts are genuinely contradictory and can't be cleanly merged,
do NOT force a resolution — just exit with a non-zero status to signal escalation."

  if polytoken exec --facet execute --max-tool-turns 30 "$RESOLVE_PROMPT"; then
    # Verify conflicts are actually gone
    REMAINING=$(jj resolve --list 2>/dev/null | head -1 || true)
    if [ -n "$REMAINING" ]; then
      log "Agent exited but conflicts remain — rolling back"
      jj op restore "$PRE_REBASE_OP"
      _post_conflict_comment "$ISSUE_NUMBER" "$WORKSPACE_NAME"
      exit 1
    fi
    log "Conflicts resolved by agent"
  else
    log "Agent could not resolve conflicts — rolling back"
    jj op restore "$PRE_REBASE_OP"
    _post_conflict_comment "$ISSUE_NUMBER" "$WORKSPACE_NAME"
    exit 1  # skip push, leave workspace intact
  fi
fi

# 5. Advance main to the latest non-empty commit.
# @ is the working copy — after the implementer commits, @ is an empty
# commit on top of the actual work. We want main to point at the latest
# commit with actual content, not the empty working copy.
# "latest non-empty commit in main..@" = the last commit that has a diff.
TARGET=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | tail -1)
if [ -z "$TARGET" ]; then
  # Fallback: if no non-empty commits found, use @ directly
  TARGET="@"
fi
jj bookmark move main --to "$TARGET" || {
  log "WARN: bookmark move failed — main may have moved. Re-fetching and retrying."
  jj git fetch
  jj rebase -s 'main..@' -d main@origin 2>/dev/null || true
  TARGET=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | tail -1)
  if [ -z "$TARGET" ]; then TARGET="@"; fi
  jj bookmark move main --to "$TARGET"
}

# 6. Push
jj git push --bookmark main

# 7. Close the GitHub issue with a comment linking the pushed commit.
# Get the short commit hash of the tip we just pushed.
PUSHED_COMMIT=$(jj log -r "$TARGET" --no-graph -T 'commit_id' 2>/dev/null | head -1 | cut -c1-12)
gh issue close "$ISSUE_NUMBER" --repo TimoFreiberg/pantoken --comment "$(cat <<EOF
<!-- autopilot -->

Implemented and pushed to main in commit $PUSHED_COMMIT.
EOF
)" || log "WARN: failed to close issue #$ISSUE_NUMBER"

log "Successfully pushed issue #$ISSUE_NUMBER to main (commit $PUSHED_COMMIT)"
