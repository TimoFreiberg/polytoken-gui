#!/usr/bin/env bash
# claims.sh — claim/release/stale-recovery for issue tracking.
#
# A local claim file at ~/.local/share/pantoken-autopilot/claims.json tracks
# which issues are currently being worked on. All operations are serialized
# with a mkdir-based lock (portable: works on macOS and Linux without flock).
#
# This file is sourced (not executed) by main.sh — it provides functions.
# The claims file is initialized by main.sh before these functions are called.
#
# Claim structure:
# {"issue_number":23,"session_id":"abc","slot":0,"claimed_at":"2026-07-13T08:14:22Z"}
#
# Functions:
#   claim_issue <issue_number> <slot>
#   release_claim <issue_number>
#   update_claim_session <issue_number> <session_id>
#   get_claim_issue <slot>
#   get_claim_session_id <issue_number>
#   count_active_slots
#   find_free_slot
#   recover_stale_claims

CLAIMS_DIR="$HOME/.local/share/pantoken-autopilot"
CLAIMS_FILE="$CLAIMS_DIR/claims.json"
LOCK_DIR="$CLAIMS_DIR/.claims.lock"

# Ensure claims file exists
init_claims() {
  mkdir -p "$CLAIMS_DIR"
  if [ ! -f "$CLAIMS_FILE" ]; then
    echo '{"claims":[]}' > "$CLAIMS_FILE"
  fi
}

# Acquire a lock (mkdir is atomic on POSIX). Waits up to 30s.
# If the lock is stale (older than 5 minutes), it's removed and retried.
_acquire_lock() {
  local attempts=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    # Check for stale lock (older than 5 min — likely from a crashed process)
    if [ -d "$LOCK_DIR" ]; then
      local lock_age
      local now
      local lock_time
      now=$(date +%s)
      # stat -f %m on BSD/macOS, stat -c %Y on Linux
      lock_time=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
      lock_age=$((now - lock_time))
      if [ "$lock_age" -gt 300 ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
        continue
      fi
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 60 ]; then
      echo "ERROR: could not acquire claims lock after 30s" >&2
      return 1
    fi
    sleep 0.5
  done
}

_release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

# Claim an issue: claim_issue <issue_number> <slot>
claim_issue() {
  local issue_number=$1 slot=$2
  local claimed_at
  claimed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  _acquire_lock || return 1
  local tmp
  tmp=$(mktemp)
  jq --argjson n "$issue_number" \
     --argjson s "$slot" \
     --arg t "$claimed_at" \
     --arg sid "" \
     '.claims += [{"issue_number":$n,"session_id":$sid,"slot":$s,"claimed_at":$t}]' \
     "$CLAIMS_FILE" > "$tmp"
  mv "$tmp" "$CLAIMS_FILE"
  _release_lock
}

# Release a claim: release_claim <issue_number>
release_claim() {
  local issue_number=$1
  _acquire_lock || return 1
  local tmp
  tmp=$(mktemp)
  jq --argjson n "$issue_number" \
     '.claims |= map(select(.issue_number != $n))' \
     "$CLAIMS_FILE" > "$tmp"
  mv "$tmp" "$CLAIMS_FILE"
  _release_lock
}

# Update claim with session_id: update_claim_session <issue_number> <session_id>
update_claim_session() {
  local issue_number=$1 session_id=$2
  _acquire_lock || return 1
  local tmp
  tmp=$(mktemp)
  jq --argjson n "$issue_number" \
     --arg sid "$session_id" \
     '(.claims[] | select(.issue_number == $n) | .session_id) = $sid' \
     "$CLAIMS_FILE" > "$tmp"
  mv "$tmp" "$CLAIMS_FILE"
  _release_lock
}

# Get the issue number for a given slot: get_claim_issue <slot>
get_claim_issue() {
  local slot=$1
  _acquire_lock || return 1
  jq -r --argjson s "$slot" \
    '.claims[] | select(.slot == $s) | .issue_number' \
    "$CLAIMS_FILE"
  _release_lock
}

# Get session_id for an issue: get_claim_session_id <issue_number>
get_claim_session_id() {
  local issue_number=$1
  _acquire_lock || return 1
  jq -r --argjson n "$issue_number" \
    '.claims[] | select(.issue_number == $n) | .session_id' \
    "$CLAIMS_FILE"
  _release_lock
}

# Count active slots
count_active_slots() {
  _acquire_lock || return 1
  jq -r '.claims | length' "$CLAIMS_FILE"
  _release_lock
}

# Find the lowest free slot index (0..MAX_CONCURRENT-1)
find_free_slot() {
  _acquire_lock || return 1
  for slot in $(seq 0 $((MAX_CONCURRENT - 1))); do
    if ! jq -e --argjson s "$slot" '.claims[] | select(.slot == $s)' \
         "$CLAIMS_FILE" >/dev/null 2>&1; then
      echo "$slot"
      _release_lock
      return
    fi
  done
  echo "-1"  # no free slot
  _release_lock
}

# Helper: release a stale claim AND clean up its orphaned workspace.
# Called from recover_stale_claims (lock already held).
_release_stale_claim() {
  local issue_number=$1 reason=$2
  local tmp
  tmp=$(mktemp)
  jq --argjson n "$issue_number" \
     '.claims |= map(select(.issue_number != $n))' \
     "$CLAIMS_FILE" > "$tmp"
  mv "$tmp" "$CLAIMS_FILE"
  echo "Recovered stale claim for issue #$issue_number ($reason)" >&2

  # Clean up orphaned workspace (lock already held — safe to do I/O here)
  local repo_root="${PANTOKEN_REPO_ROOT:-/Users/timo/src/pantoken}"
  local ws_name="autopilot-$issue_number"
  local ws_dir="$repo_root/../pantoken-autopilot-$issue_number"
  if [ -d "$ws_dir" ]; then
    # Forget the workspace from jj, then remove the directory
    cd "$repo_root" 2>/dev/null && jj workspace forget "$ws_name" 2>/dev/null || true
    rm -rf "$ws_dir"
    echo "Cleaned up orphaned workspace $ws_name" >&2
    cd "$CLAIMS_DIR" 2>/dev/null || true
  fi
}

# Recover stale claims: check if daemon PID is still alive.
# If the daemon for a claim is dead, release the claim.
recover_stale_claims() {
  _acquire_lock || return 1

  # Read all claims and check each one
  local count
  count=$(jq -r '.claims | length' "$CLAIMS_FILE")
  local i=0
  while [ "$i" -lt "$count" ]; do
    local sid issue_number
    sid=$(jq -r ".claims[$i].session_id" "$CLAIMS_FILE")
    issue_number=$(jq -r ".claims[$i].issue_number" "$CLAIMS_FILE")

    # If session_id is empty, the daemon hasn't spawned yet — keep the claim
    if [ -z "$sid" ] || [ "$sid" = "null" ]; then
      i=$((i + 1))
      continue
    fi

    local startup_file
    startup_file="$HOME/.local/share/polytoken/sessions/$sid/startup.json"
    if [ ! -f "$startup_file" ]; then
      # No startup.json — daemon never started or was cleaned up
      _release_stale_claim "$issue_number" "no startup.json"
      count=$(jq -r '.claims | length' "$CLAIMS_FILE")
      continue
    fi

    local pid
    pid=$(jq -r '.pid // 0' "$startup_file" 2>/dev/null || echo 0)
    if [ "$pid" = "0" ] || [ "$pid" = "null" ]; then
      _release_stale_claim "$issue_number" "no PID"
      count=$(jq -r '.claims | length' "$CLAIMS_FILE")
      continue
    elif ! kill -0 "$pid" 2>/dev/null; then
      _release_stale_claim "$issue_number" "daemon PID $pid dead"
      count=$(jq -r '.claims | length' "$CLAIMS_FILE")
      continue
    fi
    i=$((i + 1))
  done

  _release_lock
}
