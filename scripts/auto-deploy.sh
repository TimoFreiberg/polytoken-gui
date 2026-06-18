#!/usr/bin/env bash
# auto-deploy.sh — poll origin/main; build, smoke-test & flip if there are new commits.
#
# Blue-green: two checkouts behind a symlink.
#   ~/pilot-blue, ~/pilot-green   — slots (git clones + built client/dist)
#   ~/pilot-live                  — symlink to the active slot (what the daemon runs)
#
# Each tick builds + smoke-tests the INACTIVE slot, and only flips the symlink +
# restarts if the smoke passes — a bad build never touches the live slot. The restart
# needs no sudo: the com.pilot.server daemon runs as your user, so we kill its pid
# (recorded by run.sh) and KeepAlive respawns it from the now-flipped slot. After the
# flip we re-check /health and roll back (re-flip + restart) if the new slot won't come
# up. Runs as a LaunchDaemon (see deploy/com.pilot.deploy.plist).
#
# Usage: auto-deploy.sh [--force [--allow-stale-checkout]]
#   --force                 skip the fetch/diff check, just build & restart current HEAD
#   --allow-stale-checkout  with --force, don't pull — deploy whatever's checked out
set -euo pipefail

FORCE=false
ALLOW_STALE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true ;;
    --allow-stale-checkout) ALLOW_STALE=true ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

BLUE_DIR="$HOME/pilot-blue"
GREEN_DIR="$HOME/pilot-green"
LIVE_LINK="$HOME/pilot-live"

DATA_DIR="${PILOT_DATA_DIR:-$HOME/.local/state/pilot}"
ENV_FILE="$DATA_DIR/pilot.env"
# Source the same env the server uses, so we agree on PILOT_PORT (post-flip health
# check) and pick up PILOT_VERIFY_SIGNATURES if you set it there.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
LIVE_PORT="${PILOT_PORT:-8787}"
PIDFILE="$DATA_DIR/pilot.pid"
EVENTS_LOG="$HOME/Library/Logs/pilot-deploy-events.jsonl"

mkdir -p "$DATA_DIR" "$(dirname "$EVENTS_LOG")"

# Single-flight lock so the 60s timer and a manual `deploy:now` run never stage into
# the same slot at once. mkdir is atomic; macOS has no flock. Steal a >30min-old lock
# (a previous run that died without cleaning up).
LOCKDIR="$DATA_DIR/auto-deploy.lock"
if [[ -d "$LOCKDIR" && -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +30 2>/dev/null)" ]]; then
  rmdir "$LOCKDIR" 2>/dev/null || true
fi
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  echo "another deploy is already running — skipping" >&2
  exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

log_event() {
  local level="$1" msg="$2" ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  # escape backslashes + quotes so the JSONL stays valid
  msg=${msg//\\/\\\\}; msg=${msg//\"/\\\"}
  printf '{"timestamp":"%s","level":"%s","message":"%s"}\n' "$ts" "$level" "$msg" >> "$EVENTS_LOG"
}
trap 'log_event "error" "Unexpected failure (line $LINENO, exit $?)"' ERR

read_pid() { [[ -f "$PIDFILE" ]] && tr -d '[:space:]' < "$PIDFILE" || true; }

health_ok() { curl -fsS --max-time 3 "http://127.0.0.1:${LIVE_PORT}/health" >/dev/null 2>&1; }

# Flip the live symlink atomically: ln -sfn is unlink+symlink (not atomic), so create
# a temp link and mv it over — mv uses rename(2), which is atomic.
flip_to() {
  local target="$1" tmp="${LIVE_LINK}.tmp.$$"
  ln -sfn "$target" "$tmp"
  /bin/mv -fh "$tmp" "$LIVE_LINK"
}

# Kill the running server (no sudo — it's our user's process) and wait for KeepAlive
# to respawn it from the current symlink target. We confirm a *real* restart by
# requiring a fresh pid (run.sh rewrites the pidfile on boot) AND a healthy /health.
restart_and_wait() {
  local timeout="${1:-90}" old new i=0
  old="$(read_pid)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
  else
    # No live pid recorded — fall back to matching the server process directly.
    pkill -U "$(id -u)" -f 'bun run src/index.ts' 2>/dev/null || true
  fi
  while (( i < timeout )); do
    new="$(read_pid)"
    if [[ -n "$new" && "$new" != "$old" ]] && kill -0 "$new" 2>/dev/null && health_ok; then
      return 0
    fi
    sleep 1; (( i++ ))
  done
  return 1
}

# ── Figure out active vs staging slot ──
ACTIVE="$(readlink "$LIVE_LINK" || true)"
if [[ "$ACTIVE" == "$BLUE_DIR" ]]; then
  STAGE_DIR="$GREEN_DIR"; STAGE_NAME="green"
elif [[ "$ACTIVE" == "$GREEN_DIR" ]]; then
  STAGE_DIR="$BLUE_DIR"; STAGE_NAME="blue"
else
  log_event "error" "LIVE_LINK points to unexpected target: '$ACTIVE' — run deploy-ctl.sh setup-live"
  exit 1
fi
[[ -d "$ACTIVE/.git" ]] || { log_event "error" "Active slot $ACTIVE is not a git repo"; exit 1; }

cd "$STAGE_DIR"

if [[ "$FORCE" == false ]]; then
  git -C "$ACTIVE" fetch origin main --quiet
  git fetch origin main --quiet

  ACTIVE_HEAD=$(git -C "$ACTIVE" rev-parse HEAD)
  REMOTE=$(git -C "$ACTIVE" rev-parse origin/main)
  [[ "$ACTIVE_HEAD" == "$REMOTE" ]] && exit 0   # nothing new — the common case

  STAGE_REMOTE=$(git rev-parse origin/main)
  if [[ "$REMOTE" != "$STAGE_REMOTE" ]]; then
    log_event "error" "Slots disagree on origin/main (active=$REMOTE staging=$STAGE_REMOTE)"
    exit 1
  fi

  # Optional commit-signature gate (off by default; tangled.org isn't GitHub, so this
  # verifies YOUR ssh-signed commits via scripts/allowed-signers, not web-flow keys).
  if [[ "${PILOT_VERIFY_SIGNATURES:-false}" == "true" ]]; then
    git config gpg.ssh.allowedSignersFile "$ACTIVE/scripts/allowed-signers"
    NEW_COMMITS=$(git rev-list --first-parent "$ACTIVE_HEAD"..origin/main)
    [[ -n "$NEW_COMMITS" ]] || { log_event "error" "No commits in range $ACTIVE_HEAD..origin/main — possible force-push?"; exit 1; }
    for c in $NEW_COMMITS; do
      git verify-commit "$c" 2>/dev/null || { log_event "error" "Unsigned/untrusted commit $c — refusing deploy"; exit 1; }
    done
  fi

  COMMITS=$(git log --oneline --max-count=5 "$ACTIVE_HEAD"..origin/main 2>/dev/null || true)
  log_event "info" "New commits on origin/main — deploying to $STAGE_NAME: ${COMMITS//$'\n'/ | }"

  # Flag (don't auto-apply) plist changes — the installed LaunchDaemon plists need a
  # one-time `sudo deploy-ctl.sh reinstall` to pick up edits; code deploys don't.
  if git diff --name-only "$ACTIVE_HEAD"..origin/main | grep -q '^deploy/.*\.plist$'; then
    log_event "warn" "deploy/*.plist changed in this range — run 'sudo scripts/deploy-ctl.sh reinstall' to apply"
  fi

  git pull --ff-only origin main
else
  if [[ "$ALLOW_STALE" == false ]]; then
    git fetch origin main --quiet
    git pull --ff-only origin main
  fi
  log_event "info" "Forced deploy to $STAGE_NAME at $(git rev-parse --short HEAD)"
fi

# ── Build + smoke-test the staged slot (live slot still untouched) ──
bun install --frozen-lockfile
bun run build

SMOKE="$STAGE_DIR/scripts/smoke-test.ts"
if [[ -f "$SMOKE" ]]; then
  if ! bun "$SMOKE" "$STAGE_DIR"; then
    log_event "error" "Smoke test failed on $STAGE_NAME at $(git rev-parse --short HEAD) — not flipping"
    exit 1
  fi
fi

STAGE_SHA=$(git rev-parse --short HEAD)

# ── Flip + restart (no sudo) ──
flip_to "$STAGE_DIR"
if restart_and_wait 90; then
  log_event "info" "Deploy complete — $STAGE_NAME ($STAGE_SHA) is live."
  exit 0
fi

# ── New slot won't come up healthy: roll back to the previous slot ──
log_event "error" "New slot $STAGE_NAME ($STAGE_SHA) failed /health after flip — rolling back to $ACTIVE"
flip_to "$ACTIVE"
if restart_and_wait 90; then
  log_event "info" "Rollback succeeded — previous slot is live again."
else
  log_event "error" "Rollback also failed — pilot is DOWN, manual intervention required."
fi
exit 1
