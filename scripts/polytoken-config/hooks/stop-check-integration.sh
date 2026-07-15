#!/usr/bin/env bash
# stop-check-integration.sh — stop hook for issue implementer agents.
#
# Fires when the agent would finish. If there are non-empty commits above
# main that have NOT been pushed (integrated), the hook returns "continue"
# with a redirect to `just integrate-into-main`, so the agent runs the
# integration step instead of stopping prematurely.
#
# To prevent infinite loops, a redirect counter caps at MAX_REDIRECTS (3).
# After that the hook lets the agent stop with a warning.
#
# Environment (set by polytoken):
#   POLYTOKEN_PROJECT_DIR   The session's project/working directory.
#
# Workspace files (written by implement-issue.ts):
#   .autopilot-issue-number  The issue number being implemented.
#
# Exit codes / stdout:
#   exit 0, no output    → stop (let the model finish)
#   exit 0, JSON on stdout → continue (with reason the model sees)
set -euo pipefail

MAX_REDIRECTS=3
REDIRECT_FILE="$PWD/.autopilot-stop-redirects"

issue_number=""
if [ -f "$PWD/.autopilot-issue-number" ]; then
  issue_number=$(cat "$PWD/.autopilot-issue-number" 2>/dev/null || true)
fi

# Not an implementer session — let it stop normally.
if [ -z "$issue_number" ]; then
  exit 0
fi

# Check for non-empty commits above main that need integration.
non_empty=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | head -1 || true)

# No unpushed commits — integration is complete (or never started).
# Either way, let the agent stop.
if [ -z "$non_empty" ]; then
  rm -f "$REDIRECT_FILE" 2>/dev/null || true
  exit 0
fi

# There are unpushed commits. Count redirects to avoid infinite loops.
redirect_count=0
if [ -f "$REDIRECT_FILE" ]; then
  redirect_count=$(cat "$REDIRECT_FILE" 2>/dev/null || echo 0)
fi

if [ "$redirect_count" -ge "$MAX_REDIRECTS" ]; then
  # Exhausted redirects — let the agent stop, but warn.
  rm -f "$REDIRECT_FILE" 2>/dev/null || true
  cat <<'JSON'
{"outcome":"stop"}
JSON
  exit 0
fi

# Increment redirect counter.
echo $((redirect_count + 1)) > "$REDIRECT_FILE"

# Return continue with a redirect message the agent will see.
cat <<JSON
{"outcome":"continue","reason":"You have NOT yet integrated your work into main. There are unpushed commits above main. Run the integration command now:\n\njust integrate-into-main ${issue_number}\n\nThis acquires a lock, rebases onto latest main, runs tests, and pushes. If it exits 2 (conflicts), resolve them with the jj-resolve-conflicts skill and retry. Do not stop until integration succeeds (exit 0) or you have posted a comment explaining a blocking failure."}
JSON
