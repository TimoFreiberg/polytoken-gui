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
#   4. Check for conflicts — if found, roll back, post issue comment, exit 1
#   5. Advance main bookmark to our tip
#   6. Push to origin
#
# Usage: finalize.sh <issue_number>
set -euo pipefail

ISSUE_NUMBER="${1:?usage: finalize.sh <issue_number>}"

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

WORKSPACE_NAME="autopilot-$ISSUE_NUMBER"

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
  # Roll back to pre-rebase state
  jj op restore "$PRE_REBASE_OP"

  # Post a comment on the GitHub issue and leave workspace for manual resolution
  DIFF_SUMMARY=$(jj diff --summary 2>/dev/null || echo "unable to generate diff summary")
  gh issue comment "$ISSUE_NUMBER" --repo TimoFreiberg/pantoken --body "$(cat <<EOF
<!-- autopilot -->

Implementation complete but push failed: rebase conflict with concurrent work.
Manual resolution needed. The work is in workspace \`$WORKSPACE_NAME\` at \`../pantoken-autopilot-$ISSUE_NUMBER\`.

\`\`\`
$DIFF_SUMMARY
\`\`\`
EOF
)" || true

  log "ERROR: rebase conflict — rolled back, posted comment on issue #$ISSUE_NUMBER"
  exit 1  # skip push, leave workspace intact
fi

# 5. Advance main to our tip (no --allow-backwards: if main moved forward,
# the fetch+rebase above should have handled it; if move fails, retry)
jj bookmark move main --to @ || {
  log "WARN: bookmark move failed — main may have moved. Re-fetching and retrying."
  jj git fetch
  jj rebase -s 'main..@' -d main@origin 2>/dev/null || true
  jj bookmark move main --to @
}

# 6. Push
jj git push --bookmark main

log "Successfully pushed issue #$ISSUE_NUMBER to main"
