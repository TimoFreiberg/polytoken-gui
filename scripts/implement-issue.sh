#!/usr/bin/env bash
# implement-issue.sh — per-issue entry point for autonomous implementation.
#
# Creates a jj workspace, spawns a headless polytoken daemon, seeds it with
# bypass_plus permissions + plan facet + adventurous handoff, and opens a
# zellij tab with the TUI. The agent runs the full plan→review→execute→
# review loop and calls `just integrate-into-main` when done.
#
# Usage: implement-issue.sh <issue-url-or-number>
#   The argument can be a full GitHub issue URL, "#N", or just "N".
set -euo pipefail

REPO_ROOT="${PANTOKEN_REPO_ROOT:-/Users/timo/src/pantoken}"
SCRIPT_DIR="$REPO_ROOT/scripts"

# ─── Logging ─────────────────────────────────────────────────────────────────

ts() { date '+%H:%M:%S'; }
log() { echo "[$(ts)] $*" >&2; }

# ─── Source helpers ──────────────────────────────────────────────────────────

# shellcheck source=claims.sh
source "$SCRIPT_DIR/claims.sh"
init_claims

# Track spawned daemon PID for cleanup on exit
SPAWNED_DAEMON_PID=""

cleanup_on_exit() {
  if [ -n "$SPAWNED_DAEMON_PID" ] && kill -0 "$SPAWNED_DAEMON_PID" 2>/dev/null; then
    log "Killing daemon PID $SPAWNED_DAEMON_PID"
    kill "$SPAWNED_DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup_on_exit EXIT
trap 'log ""; exit 130' INT TERM

# ─── Dependency checks ───────────────────────────────────────────────────────

check_dep() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required but not found in PATH" >&2
    echo "  $2" >&2
    exit 1
  fi
}

check_dep polytoken "Install from https://github.com/TimoFreiberg/polytoken"
check_dep jj "Install from https://github.com/jj-vcs/jj"
check_dep gh "Install from https://cli.github.com/"
check_dep jq "Install with: brew install jq"
check_dep zellij "Install with: brew install zellij"
check_dep curl "Should be pre-installed on macOS"

# Verify gh is authenticated
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# Verify we're in a jj repository
cd "$REPO_ROOT"
if ! jj workspace list >/dev/null 2>&1; then
  echo "ERROR: not in a jj repository at $REPO_ROOT" >&2
  exit 1
fi

# Verify the main bookmark exists
if ! jj bookmark list main >/dev/null 2>&1; then
  echo "ERROR: no 'main' bookmark found in the repository" >&2
  exit 1
fi

# ─── Parse issue argument ─────────────────────────────────────────────────────

ISSUE_INPUT="${1:?usage: implement-issue.sh <issue-url-or-number>}"

# Extract issue number from URL, "#N", or "N"
if [[ "$ISSUE_INPUT" =~ ^https?:// ]]; then
  ISSUE_NUMBER="${ISSUE_INPUT##*/}"
elif [[ "$ISSUE_INPUT" =~ ^# ]]; then
  ISSUE_NUMBER="${ISSUE_INPUT#\#}"
else
  ISSUE_NUMBER="$ISSUE_INPUT"
fi

if ! [[ "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not parse issue number from: $ISSUE_INPUT" >&2
  exit 1
fi

ISSUE_URL="https://github.com/TimoFreiberg/pantoken/issues/$ISSUE_NUMBER"

# ─── Recover stale claims from crashed runs ──────────────────────────────────

recover_stale_claims

# ─── Check if issue is already claimed ───────────────────────────────────────

if is_issue_claimed "$ISSUE_NUMBER"; then
  echo "ERROR: issue #$ISSUE_NUMBER is already claimed (another agent may be working on it)" >&2
  exit 1
fi

# ─── Fetch issue title ────────────────────────────────────────────────────────

ISSUE_TITLE=$(gh issue view "$ISSUE_NUMBER" --repo TimoFreiberg/pantoken --json title -q '.title' 2>/dev/null || echo "Issue #$ISSUE_NUMBER")
log "Implementing issue #$ISSUE_NUMBER: $ISSUE_TITLE"

# ─── Claim the issue ──────────────────────────────────────────────────────────

claim_issue "$ISSUE_NUMBER"

# ─── Create jj workspace ──────────────────────────────────────────────────────

WS_NAME="issue-$ISSUE_NUMBER"
WS_DIR="$REPO_ROOT/../pantoken-issue-$ISSUE_NUMBER"

cd "$REPO_ROOT"
if [ -d "$WS_DIR" ]; then
  log "WARN: workspace dir for issue #$ISSUE_NUMBER still exists — cleaning up stale workspace"
  jj workspace forget "$WS_NAME" 2>/dev/null || true
  rm -rf "$WS_DIR"
fi

jj workspace add "../pantoken-issue-$ISSUE_NUMBER" --name "$WS_NAME" || {
  log "ERROR: failed to create workspace for issue #$ISSUE_NUMBER"
  release_claim "$ISSUE_NUMBER"
  exit 1
}

cd "$WS_DIR"
log "Workspace created at $WS_DIR"

# Install dependencies
bun install

# ─── Spawn headless daemon ───────────────────────────────────────────────────

DAEMON_OUT=$(polytoken new --no-attach)
SESSION_ID=$(echo "$DAEMON_OUT" | sed -n 's/.*session_id=\([^ ]*\).*/\1/p')
PORT=$(echo "$DAEMON_OUT" | sed -n 's/.*port=\([0-9]*\).*/\1/p')

if [ -z "$SESSION_ID" ] || [ -z "$PORT" ]; then
  log "ERROR: failed to parse daemon output: $DAEMON_OUT"
  release_claim "$ISSUE_NUMBER"
  exit 1
fi

log "Daemon spawned: session=$SESSION_ID port=$PORT"

# Read daemon PID for cleanup
STARTUP_FILE="$HOME/.local/share/polytoken/sessions/$SESSION_ID/startup.json"
if [ -f "$STARTUP_FILE" ]; then
  SPAWNED_DAEMON_PID=$(jq -r '.pid // empty' "$STARTUP_FILE" 2>/dev/null || true)
fi

# Write session_id for integrate-into-main.sh to read
echo "$SESSION_ID" > "$WS_DIR/.autopilot-session-id"

# Update claim with session_id
update_claim_session "$ISSUE_NUMBER" "$SESSION_ID"

# ─── Seed the session ────────────────────────────────────────────────────────

"$SCRIPT_DIR/seed-session.sh" "$SESSION_ID" "$PORT" "$ISSUE_URL" "$ISSUE_TITLE"

# ─── Open zellij tab with TUI (blocks until TUI closes) ───────────────────────

log "Opening zellij tab for issue #$ISSUE_NUMBER..."
zellij action new-tab --block-until-exit \
  --cwd "$WS_DIR" \
  --name "#$ISSUE_NUMBER" \
  -- polytoken attach "$SESSION_ID"

# ─── Post-TUI: check integration status ──────────────────────────────────────

log "TUI closed. Checking integration status..."

cd "$WS_DIR"
REMAINING=$(jj log -r 'main@origin..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | head -1 || true)

if [ -n "$REMAINING" ]; then
  log "WARN: commits remain above main@origin — integration may not have succeeded."
  log "Workspace left intact at: $WS_DIR"
  log "Manual recovery: cd $WS_DIR && just integrate-into-main $ISSUE_NUMBER"
  # Don't clean up — leave for manual recovery
  exit 0
fi

# ─── Cleanup ──────────────────────────────────────────────────────────────────

log "Integration succeeded. Cleaning up workspace..."
cd "$REPO_ROOT"
jj workspace forget "$WS_NAME" 2>/dev/null || true
rm -rf "$WS_DIR"
release_claim "$ISSUE_NUMBER"
log "Done. Issue #$ISSUE_NUMBER implemented and integrated."
