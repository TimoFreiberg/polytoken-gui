#!/usr/bin/env bash
# integrate-into-main.sh — linearize jj history onto main and push.
#
# Implements a hybrid lock model: the script owns the lock (file-based,
# survives process death), and conflict resolution is delegated back to
# the calling agent via exit code 2.
#
# Must be run from inside the implementer's jj workspace.
#
# Usage: integrate-into-main.sh <issue_number>
# Exit codes: 0=success, 2=conflicts (lock held, resolve and retry), 1=error
#
# Environment:
#   INTEGRATE_DRY_RUN=1  Skip push and gh issue close (for testing)
set -euo pipefail

ISSUE_NUMBER="${1:?usage: integrate-into-main.sh <issue_number>}"

REPO_ROOT="${PANTOKEN_REPO_ROOT:-/Users/timo/src/pantoken}"
LOCK_FILE="$REPO_ROOT/.merge-lock"
STALE_THRESHOLD=1800  # 30 minutes in seconds
POLL_INTERVAL=2       # seconds between lock polls

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }

# ─── Read session ID from workspace ──────────────────────────────────────────

SESSION_FILE="$PWD/.autopilot-session-id"
CURRENT_SESSION=""
if [ -f "$SESSION_FILE" ]; then
  CURRENT_SESSION=$(cat "$SESSION_FILE" 2>/dev/null || true)
fi

# ─── Lock acquisition ────────────────────────────────────────────────────────

# Check if a PID is alive
_pid_alive() {
  local pid=$1
  [ "$pid" -gt 0 ] 2>/dev/null || return 1
  kill -0 "$pid" 2>/dev/null
}

# Write lock JSON to a temp file, then atomically move it into place
_write_lock() {
  local tmpfile
  tmpfile=$(mktemp)
  jq -n \
    --argjson pid "$$" \
    --arg sid "$CURRENT_SESSION" \
    --argjson issue "$ISSUE_NUMBER" \
    --argjson ts "$(date +%s)" \
    '{pid:$pid, session_id:$sid, issue_number:$issue, timestamp:$ts}' \
    > "$tmpfile"
  mv -f "$tmpfile" "$LOCK_FILE"
}

acquire_lock() {
  local lock_json
  lock_json=$(jq -n \
    --argjson pid "$$" \
    --arg sid "$CURRENT_SESSION" \
    --argjson issue "$ISSUE_NUMBER" \
    --argjson ts "$(date +%s)" \
    '{pid:$pid, session_id:$sid, issue_number:$issue, timestamp:$ts}')

  while true; do
    # Attempt atomic creation with noclobber (in a subshell so it doesn't leak)
    if (set -o noclobber; echo "$lock_json" > "$LOCK_FILE") 2>/dev/null; then
      # We hold the lock
      return 0
    fi

    # File exists — read and evaluate the existing lock
    local existing_pid existing_sid existing_ts
    existing_pid=$(jq -r '.pid // 0' "$LOCK_FILE" 2>/dev/null || echo 0)
    existing_sid=$(jq -r '.session_id // ""' "$LOCK_FILE" 2>/dev/null || echo "")
    existing_ts=$(jq -r '.timestamp // 0' "$LOCK_FILE" 2>/dev/null || echo 0)

    if _pid_alive "$existing_pid"; then
      # PID is alive — another integration is in progress
      log "Another integration in progress (PID $existing_pid, session $existing_sid), waiting..."
      sleep "$POLL_INTERVAL"
      continue
    fi

    # PID is dead — check if same session (retry after conflict resolution)
    if [ "$existing_sid" = "$CURRENT_SESSION" ] && [ -n "$CURRENT_SESSION" ]; then
      # Same session re-acquisition — immediate
      log "Re-acquiring lock (same session, PID $existing_pid dead)"
      _write_lock
      return 0
    fi

    # PID dead, different session — check lock age
    local now lock_age
    now=$(date +%s)
    lock_age=$((now - existing_ts))

    if [ "$lock_age" -lt "$STALE_THRESHOLD" ]; then
      # Recent lock from a different session — likely resolving conflicts
      log "Integration in progress (session $existing_sid appears to be resolving conflicts, waiting...)"
      sleep "$POLL_INTERVAL"
      continue
    fi

    # Stale lock — steal it
    local age_min=$((lock_age / 60))
    log "Stale lock detected (PID $existing_pid dead, age ${age_min}m, session $existing_sid), taking over"
    _write_lock
    return 0
  done
}

release_lock() {
  rm -f "$LOCK_FILE" 2>/dev/null || true
}

# ─── Acquire lock ────────────────────────────────────────────────────────────

acquire_lock
log "Lock acquired (PID $$, session $CURRENT_SESSION)"

# Ensure lock is released on unexpected exit (but NOT on conflict — exit 2 keeps it)
RELEASE_ON_EXIT=true
_release_if_needed() {
  if [ "$RELEASE_ON_EXIT" = true ]; then
    release_lock
  fi
}
trap _release_if_needed EXIT

# ─── Integration steps ────────────────────────────────────────────────────────

# 1. Fetch latest main
log "Fetching latest main..."
jj git fetch

# 2. Capture pre-rebase op ID for rollback
PRE_REBASE_OP=$(jj op log --limit 1 --no-graph -T id)
log "Pre-rebase op: $PRE_REBASE_OP"

# 3. Guard: check for non-empty commits in main..@
NON_EMPTY_COMMITS=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | head -1)
if [ -z "$NON_EMPTY_COMMITS" ]; then
  log "No non-empty commits in main..@ — nothing to push"
  release_lock
  RELEASE_ON_EXIT=false
  exit 0
fi

# 4. Rebase new commits onto main@origin
log "Rebasing main..@ onto main@origin..."
jj rebase -s 'main..@' -d main@origin 2>/dev/null || true

# 5. Check for conflicts
CONFLICTS=$(jj resolve --list 2>/dev/null | head -1 || true)
if [ -n "$CONFLICTS" ]; then
  log "CONFLICTS DETECTED — resolve them using the jj-resolve-conflicts skill,"
  log "then call 'just integrate-into-main $ISSUE_NUMBER' again. The lock is still held."
  # Keep the lock — don't release it
  RELEASE_ON_EXIT=false
  exit 2
fi

# 6. Run tests
log "Running tests..."

# 6a. bun test
if ! bun test; then
  log "ERROR: bun test failed — rolling back to pre-rebase state"
  jj op restore "$PRE_REBASE_OP"
  release_lock
  RELEASE_ON_EXIT=false
  exit 1
fi

# 6b. bun run check (typecheck)
if ! bun run check; then
  log "ERROR: bun run check (typecheck) failed — rolling back to pre-rebase state"
  jj op restore "$PRE_REBASE_OP"
  release_lock
  RELEASE_ON_EXIT=false
  exit 1
fi

# 6c. cargo fmt (auto-format, not --check)
if [ -d "server-rs" ]; then
  log "Running cargo fmt in server-rs/..."
  (cd server-rs && cargo fmt)
  # If fmt produced changes, squash them into the last non-empty commit
  FMT_CHANGES=$(jj diff --summary 2>/dev/null | head -1 || true)
  if [ -n "$FMT_CHANGES" ]; then
    log "cargo fmt produced changes — squashing into last commit"
    jj squash -u 2>/dev/null || true
  fi
fi

# 7. Advance main bookmark to the latest non-empty commit
TARGET=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | tail -1)
if [ -z "$TARGET" ]; then
  log "ERROR: no non-empty commit found to advance main to"
  release_lock
  RELEASE_ON_EXIT=false
  exit 1
fi
log "Advancing main bookmark to $TARGET..."
jj bookmark move main --to "$TARGET" || {
  log "WARN: bookmark move failed — main may have moved. Re-fetching and retrying."
  jj git fetch
  jj rebase -s 'main..@' -d main@origin 2>/dev/null || true
  TARGET=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id' 2>/dev/null | tail -1)
  if [ -z "$TARGET" ]; then
    log "ERROR: no non-empty commit found after retry"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
  jj bookmark move main --to "$TARGET"
}

# 8. Push
if [ "${INTEGRATE_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: skipping jj git push"
else
  log "Pushing to origin..."
  jj git push --bookmark main
fi

# 9. Close the issue (best-effort)
PUSHED_COMMIT=$(jj log -r "$TARGET" --no-graph -T 'commit_id' 2>/dev/null | head -1 | cut -c1-12)
if [ "${INTEGRATE_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: skipping gh issue close"
else
  gh issue close "$ISSUE_NUMBER" --repo TimoFreiberg/pantoken --comment "$(cat <<EOF
<!-- autopilot -->

Implemented and pushed to main in commit $PUSHED_COMMIT.
EOF
)" 2>/dev/null || log "WARN: failed to close issue #$ISSUE_NUMBER"
fi

# 10. Release lock and exit
log "Successfully integrated issue #$ISSUE_NUMBER to main (commit $PUSHED_COMMIT)"
release_lock
RELEASE_ON_EXIT=false
exit 0
