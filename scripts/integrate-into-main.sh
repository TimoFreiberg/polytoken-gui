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
if ! [[ "$ISSUE_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: issue_number must be a positive integer" >&2
  exit 1
fi

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

    # File exists — malformed metadata is conservative: never steal it.
    local existing_pid existing_sid existing_ts
    if ! jq -e '(.pid | type == "number" and . >= 1 and floor == .) and (.session_id | type == "string") and (.timestamp | type == "number" and . >= 1 and floor == .)' "$LOCK_FILE" >/dev/null 2>&1; then
      log "Malformed or unsafe lock metadata in $LOCK_FILE; recover it manually"
      sleep "$POLL_INTERVAL"
      continue
    fi
    existing_pid=$(jq -r '.pid' "$LOCK_FILE")
    existing_sid=$(jq -r '.session_id' "$LOCK_FILE")
    existing_ts=$(jq -r '.timestamp' "$LOCK_FILE")

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
  if [ ! -f "$LOCK_FILE" ]; then return 0; fi
  if ! jq -e --argjson pid "$$" --arg sid "$CURRENT_SESSION" '.pid == $pid and .session_id == $sid' "$LOCK_FILE" >/dev/null 2>&1; then
    log "Not removing merge lock: on-disk owner does not match PID $$ and session $CURRENT_SESSION"
    return 0
  fi
  rm -f "$LOCK_FILE" 2>/dev/null || true
}

# ─── Verify commit history before taking the lock ─────────────────────────────
# Read-only checks: no rebase or lock mutation has happened yet, so failure
# is a clean exit 1 with no rollback needed.
COMMIT_MESSAGES=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'description' 2>/dev/null || true)
if [ -n "$COMMIT_MESSAGES" ]; then
  # Verify exactly one non-empty commit above main (squash enforcement)
  NON_EMPTY_COUNT=$(jj log -r 'main..@ ~ empty()' --no-graph -T 'commit_id ++ "\n"' 2>/dev/null | grep -c . || true)
  if [ "$NON_EMPTY_COUNT" -gt 1 ]; then
    log "ERROR: found $NON_EMPTY_COUNT non-empty commits above main — expected exactly one."
    log "Squash them into a single commit, then rerun 'just integrate-into-main $ISSUE_NUMBER'."
    exit 1
  fi

  # Verify commit message includes Fixes #<issue_number>
  log "Verifying commit message includes 'Fixes #$ISSUE_NUMBER'..."
  if ! echo "$COMMIT_MESSAGES" | grep -Eqi "fixes #$ISSUE_NUMBER([^0-9]|$)"; then
    log "ERROR: no commit in main..@ contains 'Fixes #$ISSUE_NUMBER' in its message."
    log "Amend your commit message to include 'Fixes #$ISSUE_NUMBER' on its own line"
    log "after the subject, then rerun 'just integrate-into-main $ISSUE_NUMBER'."
    exit 1
  fi
fi

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
REBASE_STATUS=0
jj rebase -s 'main..@' -d main@origin 2>/dev/null || REBASE_STATUS=$?

# 5. Classify rebase failures before running tests.
CONFLICTS=$(jj resolve --list 2>/dev/null | head -1 || true)
if [ -n "$CONFLICTS" ]; then
  log "CONFLICTS DETECTED — resolve them using the jj-resolve-conflicts skill,"
  log "then call 'just integrate-into-main $ISSUE_NUMBER' again. The lock is still held."
  RELEASE_ON_EXIT=false
  exit 2
fi
if [ "$REBASE_STATUS" -ne 0 ]; then
  log "ERROR: rebase failed without conflicts — rolling back to pre-rebase state"
  log "Inspect the jj error, fix the underlying problem, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
  jj op restore "$PRE_REBASE_OP" || log "WARN: failed to restore pre-rebase operation"
  release_lock
  RELEASE_ON_EXIT=false
  exit 1
fi

# 6. Run tests
log "Running tests..."

# 6a. bun test (use the package.json test script, which filters to the
#     curated test paths — bare `bun test` discovers all *.test.ts files
#     including scripts/headless/, whose subprocess-spawning integration
#     tests time out at bun's default 5000ms limit).
if ! bun run test; then
  log "ERROR: bun test failed — rolling back to pre-rebase state"
  log "Fix the failing tests, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
  jj op restore "$PRE_REBASE_OP"
  release_lock
  RELEASE_ON_EXIT=false
  exit 1
fi

# 6b. bun run check (typecheck)
if ! bun run check; then
  log "ERROR: bun run check (typecheck) failed — rolling back to pre-rebase state"
  log "Fix the typecheck errors, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
  jj op restore "$PRE_REBASE_OP"
  release_lock
  RELEASE_ON_EXIT=false
  exit 1
fi

# 6c. cargo fmt (auto-format, not --check). The workspace Cargo.toml is at the
#     repo root, so run from there with --all to cover all workspace members.
if [ -f "Cargo.toml" ]; then
  log "Running cargo fmt..."
  if ! cargo fmt --all; then
    log "ERROR: cargo fmt failed — inspect and fix the formatting error, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
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
  log "ERROR: no non-empty commit found to advance main to — inspect the jj history and workspace commits, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
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
    log "ERROR: no non-empty commit found after retry — inspect the jj history, fix the bookmark/rebase state, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
  if ! jj bookmark move main --to "$TARGET"; then
    log "ERROR: bookmark move failed after retry — inspect the jj error and main bookmark, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
}

# 8. Push
if [ "${INTEGRATE_DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN: skipping jj git push"
else
  log "Pushing to origin..."
  if ! jj git push --bookmark main; then
    log "ERROR: push failed — inspect the jj/git error, fix the remote or authentication problem, then rerun 'just integrate-into-main $ISSUE_NUMBER'"
    release_lock
    RELEASE_ON_EXIT=false
    exit 1
  fi
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
