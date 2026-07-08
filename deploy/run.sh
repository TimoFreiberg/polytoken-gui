#!/usr/bin/env bash
# Start the pilot server in prod (single process). Building is the deploy's job
# (scripts/auto-deploy.sh); this only starts an already-built slot, so a KeepAlive
# crash-restart comes back fast and never rebuilds. See deploy/DEPLOY.md.
set -euo pipefail

# Secrets + runtime config live outside the repo so they survive a blue-green slot
# flip and are never committed. PILOT_DATA_DIR is pilot's XDG state dir (where the
# VAPID private key already lives); the deploy env file sits alongside it.
PILOT_DATA_DIR="${PILOT_DATA_DIR:-$HOME/.local/state/pilot}"
ENV_FILE="$PILOT_DATA_DIR/pilot.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
export PILOT_DATA_DIR

: "${PILOT_HOST:=127.0.0.1}"   # loopback; tailscale serve proxies in
: "${PILOT_PORT:=8787}"
export PILOT_HOST PILOT_PORT

if [[ -z "${PILOT_TOKEN:-}" ]]; then
  echo "WARNING: PILOT_TOKEN is unset — the server will accept any client." >&2
fi

# Record our pid so the deploy poller can restart us with a plain kill — the daemon
# runs as your user, so no sudo — and KeepAlive respawns from the flipped slot.
# `exec` below keeps this pid, so $$ written now stays valid for the running server.
mkdir -p "$PILOT_DATA_DIR"
echo "$$" > "$PILOT_DATA_DIR/pilot.pid"

# The Rust server binary was built during deploy (scripts/auto-deploy.sh: cargo build
# --release --bin pilot-server). Point it at the built client and exec.
SLOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PILOT_CLIENT_DIST="$SLOT_DIR/client/dist"
exec "$SLOT_DIR/server-rs/target/release/pilot-server"
