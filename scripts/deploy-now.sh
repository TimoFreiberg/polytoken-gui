#!/usr/bin/env bash
# deploy-now.sh — from your dev machine, trigger an immediate deploy on the Mac Mini
# instead of waiting for the ~60s poll. Just runs the same auto-deploy.sh the daemon
# runs, over SSH, as your user — no sudo, and the single-flight lock keeps it from
# colliding with a concurrent timer tick. Output streams back to you.
#
#   PANTOKEN_DEPLOY_HOST=<mac-mini-tailnet-name> bun run deploy:now
set -euo pipefail

HOST="${PANTOKEN_DEPLOY_HOST:-}"
if [[ -z "$HOST" ]]; then
  echo "Set PANTOKEN_DEPLOY_HOST to your Mac Mini's tailnet hostname, e.g.:" >&2
  echo "  PANTOKEN_DEPLOY_HOST=mac-mini.tailnet.ts.net bun run deploy:now" >&2
  exit 1
fi

echo "Triggering deploy on $HOST…"
ssh "$HOST" 'bash "$HOME/pantoken-live/scripts/auto-deploy.sh"'
