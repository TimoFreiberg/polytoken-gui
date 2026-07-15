#!/usr/bin/env bash
# claims.sh — claim/release/stale-recovery for issue tracking.
#
# A local claim file at ~/.local/share/pantoken-autopilot/claims.json tracks
# which issues are currently being worked on. All operations are serialized
# with a mkdir-based lock (portable: works on macOS and Linux without flock).
#
# This file is sourced (not executed) by implement-issue.sh — it provides
# functions. The claims file is initialized by implement-issue.sh before
# these functions are called.
#
# Claim structure:
# {"issue_number":23,"session_id":"abc","claimed_at":"2026-07-13T08:14:22Z"}
#
# Functions:
#   claim_issue <issue_number>
#   release_claim <issue_number>
#   update_claim_session <issue_number> <session_id>
#   get_claim_session_id <issue_number>
#   is_issue_claimed <issue_number>
#   list_claimed_issues
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

# Claim an issue: claim_issue <issue_number>
claim_issue() {
  local issue_number=$1
  local claimed_at
  claimed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  _acquire_lock || return 1
  local tmp
  tmp=$(mktemp)
  jq --argjson n "$issue_number" \
     --arg t "$claimed_at" \
     --arg sid "" \
     '.claims += [{"issue_number":$n,"session_id":$sid,"claimed_at":$t}]' \
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

# Get session_id for an issue: get_claim_session_id <issue_number>
get_claim_session_id() {
  local issue_number=$1
  _acquire_lock || return 1
  jq -r --argjson n "$issue_number" \
    '.claims[] | select(.issue_number == $n) | .session_id' \
    "$CLAIMS_FILE"
  _release_lock
}

# Check if an issue is already claimed: is_issue_claimed <issue_number>
# Returns 0 (claimed) or 1 (not claimed)
is_issue_claimed() {
  local issue_number=$1
  _acquire_lock || return 1
  local result
  result=$(jq -r --argjson n "$issue_number" \
    '.claims[] | select(.issue_number == $n) | .issue_number' \
    "$CLAIMS_FILE")
  _release_lock
  [ -n "$result" ]
}

# List all claimed issue numbers (space-separated)
list_claimed_issues() {
  _acquire_lock || return 1
  jq -r '[.claims[].issue_number] | join(" ")' "$CLAIMS_FILE"
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
  local ws_name="issue-$issue_number"
  local ws_dir="$repo_root/../pantoken-issue-$issue_number"
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
