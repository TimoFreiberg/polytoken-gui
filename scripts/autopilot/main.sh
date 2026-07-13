#!/usr/bin/env bash
# main.sh — autonomous GitHub issue implementation loop.
#
# Continuously triages open GitHub issues, picks implementable ones, runs a
# plan→review→handoff→implement→review loop in a visible Polytoken TUI (with
# adventurous handoff), and when the TUI closes, linearizes jj history onto
# main and pushes. Issues needing human input get a comment and are skipped.
# Supports up to MAX_CONCURRENT concurrent implementers.
#
# Usage: main.sh [--dry-run]
#   --dry-run  Run triage only, print the decision, and exit (no implementation)
#
# Environment:
#   MAX_CONCURRENT  Max simultaneous implementers (default: 2)
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────

MAX_CONCURRENT="${MAX_CONCURRENT:-2}"
REPO_ROOT="/Users/timo/src/pantoken"
SCRIPT_DIR="$REPO_ROOT/scripts/autopilot"
DRY_RUN=false
MARKER_DIR="$HOME/.local/share/pantoken-autopilot"

[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

# ─── Logging ─────────────────────────────────────────────────────────────────

# Timestamp prefix for log lines (HH:MM:SS)
ts() { date '+%H:%M:%S'; }

# Log a message to stderr with a timestamp prefix
log() { echo "[$(ts)] $*" >&2; }

# ─── Source helpers ──────────────────────────────────────────────────────────

# shellcheck source=claims.sh
source "$SCRIPT_DIR/claims.sh"

init_claims

# Track spawned daemon PIDs for cleanup on exit
SPAWNED_DAEMON_PIDS=()

# ─── Signal handling ─────────────────────────────────────────────────────────

cleanup_on_exit() {
  log ""
  log "Autopilot shutting down..."

  # Kill any daemons we spawned
  for pid in "${SPAWNED_DAEMON_PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "Killing daemon PID $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done

  log "Done."
}

trap cleanup_on_exit EXIT
trap 'log ""; exit 130' INT TERM

# ─── Functions ───────────────────────────────────────────────────────────────

# Run a single implementation in a background subshell.
# Creates a jj workspace, spawns a headless daemon, seeds it, attaches TUI
# in a zellij tab. Blocks (in the subshell) until the TUI closes.
run_implementation() {
  local issue_number=$1 issue_url=$2 issue_title=$3 slot=$4

  # 1. Create worktree (reuse if it already exists from a crashed run)
  cd "$REPO_ROOT"
  if [ -d "$REPO_ROOT/../pantoken-autopilot-$issue_number" ]; then
    log "Workspace for issue #$issue_number already exists — reusing"
    # Forget the old workspace registration and re-add to be safe
    jj workspace forget "autopilot-$issue_number" 2>/dev/null || true
    rm -rf "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  fi
  jj workspace add "../pantoken-autopilot-$issue_number" \
    --name "autopilot-$issue_number" || {
    log "ERROR: failed to create workspace for issue #$issue_number"
    return 1
  }
  cd "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  bun install

  # 2. Spawn daemon headless
  local daemon_out session_id port
  daemon_out=$(polytoken new --no-attach)
  # Parse with sed (BSD grep on macOS has no -P flag)
  session_id=$(echo "$daemon_out" | sed -n 's/.*session_id=\([^ ]*\).*/\1/p')
  port=$(echo "$daemon_out" | sed -n 's/.*port=\([0-9]*\).*/\1/p')

  if [ -z "$session_id" ] || [ -z "$port" ]; then
    log "ERROR: failed to parse daemon output: $daemon_out"
    return 1
  fi

  # Track the daemon PID for cleanup
  local startup_file
  startup_file="$HOME/.local/share/polytoken/sessions/$session_id/startup.json"
  local daemon_pid=""
  if [ -f "$startup_file" ]; then
    daemon_pid=$(jq -r '.pid // empty' "$startup_file" 2>/dev/null || true)
    if [ -n "$daemon_pid" ]; then
      SPAWNED_DAEMON_PIDS+=("$daemon_pid")
    fi
  fi

  # Update claim with session_id
  update_claim_session "$issue_number" "$session_id"

  # 3. Seed the session via HTTP (waits for daemon readiness internally)
  "$SCRIPT_DIR/seed-session.sh" "$session_id" "$port" "$issue_url" "$issue_title"

  # 4. Attach TUI in a zellij tab (blocks until TUI closes)
  zellij action new-tab --block-until-exit \
    --cwd "$REPO_ROOT/../pantoken-autopilot-$issue_number" \
    --name "#$issue_number" \
    -- polytoken attach "$session_id"

  # When we get here, the TUI has been closed.
  # The merge + push + cleanup happens in the main loop (serial).
}

# Wait for any implementation slot to finish (done-* or failed-* marker file)
wait_for_slot_to_finish() {
  while true; do
    for slot in $(seq 0 $((MAX_CONCURRENT - 1))); do
      if [ -f "$MARKER_DIR/done-$slot" ]; then
        echo "$slot"
        return
      fi
      if [ -f "$MARKER_DIR/failed-$slot" ]; then
        echo "$slot"
        return
      fi
    done
    sleep 5
  done
}

# Merge, push, and clean up a finished implementation slot.
merge_and_cleanup_finished_slot() {
  local slot=$1
  local status="failed"
  if [ -f "$MARKER_DIR/done-$slot" ]; then
    status="done"
  fi
  rm -f "$MARKER_DIR/done-$slot" "$MARKER_DIR/failed-$slot"

  local issue_number
  issue_number=$(get_claim_issue "$slot")

  if [ -z "$issue_number" ] || [ "$issue_number" = "null" ]; then
    log "WARN: no claim found for slot $slot — skipping"
    return 0
  fi

  # If implementation failed, skip finalize — just clean up and release.
  if [ "$status" = "failed" ]; then
    log "Implementation failed for issue #$issue_number — skipping finalize"
    cd "$REPO_ROOT"
    jj workspace forget "autopilot-$issue_number" 2>/dev/null || true
    rm -rf "$REPO_ROOT/../pantoken-autopilot-$issue_number"
    release_claim "$issue_number"
    return 1
  fi

  # Finalize: linearize + push (serial — no flock needed, runs in main loop)
  cd "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  if ! "$SCRIPT_DIR/finalize.sh" "$issue_number"; then
    log "Finalize failed — leaving workspace intact for manual resolution"
    cd "$REPO_ROOT"
    release_claim "$issue_number"
    return 1
  fi

  # Cleanup (only on success)
  cd "$REPO_ROOT"
  jj workspace forget "autopilot-$issue_number" 2>/dev/null || true
  rm -rf "$REPO_ROOT/../pantoken-autopilot-$issue_number"
  release_claim "$issue_number"
}

# ─── Main Loop ───────────────────────────────────────────────────────────────

# Clean up stale marker files from a previous crashed run
rm -f "$MARKER_DIR"/done-* "$MARKER_DIR"/failed-* 2>/dev/null || true

while true; do
  log "─── Triage cycle ───"

  # 1. Recover stale claims
  recover_stale_claims

  # 2. Count active slots
  ACTIVE_SLOTS=$(count_active_slots)
  FREE_SLOTS=$((MAX_CONCURRENT - ACTIVE_SLOTS))

  log "Active: $ACTIVE_SLOTS/$MAX_CONCURRENT slots, $FREE_SLOTS free"

  if [ "$FREE_SLOTS" -le 0 ]; then
    # All slots busy — wait for one to finish, then merge + cleanup
    FINISHED_SLOT=$(wait_for_slot_to_finish)
    merge_and_cleanup_finished_slot "$FINISHED_SLOT" || true
    continue
  fi

  # 3. Triage (serial, headless)
  # exec stdout → tee (log) → parser; stderr is captured separately
  # shellcheck disable=SC2034 # TRIAGE_LOG is used by tee in the pipe below
  TRIAGE_LOG="$MARKER_DIR/triage-$(date +%Y%m%d-%H%M%S).log"
  TRIAGE_OUTPUT=$(cd "$REPO_ROOT" && polytoken exec --facet plan --max-tool-turns 15 \
    "$(cat "$SCRIPT_DIR/triage-prompt.md")" \
    | "$SCRIPT_DIR/parse-triage.sh" 2>/dev/null || echo '{"status":"error"}')

  STATUS=$(echo "$TRIAGE_OUTPUT" | jq -r '.status')

  if [ "$STATUS" = "no_work" ] || [ "$STATUS" = "error" ]; then
    log "No implementable issues found (status: $STATUS)"
    # If slots are active, wait for one to finish; else sleep
    if [ "$ACTIVE_SLOTS" -gt 0 ]; then
      FINISHED_SLOT=$(wait_for_slot_to_finish)
      merge_and_cleanup_finished_slot "$FINISHED_SLOT" || true
    else
      sleep 60
    fi
    continue
  fi

  if [ "$STATUS" = "implementable" ]; then
    ISSUE_NUMBER=$(echo "$TRIAGE_OUTPUT" | jq -r '.issue_number')
    ISSUE_URL=$(echo "$TRIAGE_OUTPUT" | jq -r '.issue_url')
    ISSUE_TITLE=$(echo "$TRIAGE_OUTPUT" | jq -r '.title')

    log "Triage picked issue #$ISSUE_NUMBER: $ISSUE_TITLE"

    # In dry-run mode, print the triage decision and exit
    if [ "$DRY_RUN" = true ]; then
      log "DRY RUN: would implement issue #$ISSUE_NUMBER — $ISSUE_TITLE"
      log "  URL: $ISSUE_URL"
      exit 0
    fi

    # Find the lowest free slot index
    SLOT=$(find_free_slot)
    if [ "$SLOT" = "-1" ]; then
      log "ERROR: no free slot found despite FREE_SLOTS > 0 — waiting"
      FINISHED_SLOT=$(wait_for_slot_to_finish)
      merge_and_cleanup_finished_slot "$FINISHED_SLOT" || true
      continue
    fi

    # Claim the issue (serial — no race)
    claim_issue "$ISSUE_NUMBER" "$SLOT"

    # Kick off implementation in a background process
    (
      if run_implementation "$ISSUE_NUMBER" "$ISSUE_URL" "$ISSUE_TITLE" "$SLOT"; then
        touch "$MARKER_DIR/done-$SLOT"
      else
        touch "$MARKER_DIR/failed-$SLOT"
      fi
    ) &
  fi
done
