#!/usr/bin/env bash
# deploy-ctl.sh — manage pilot's blue-green deploy on the Mac Mini.
#
#   setup-live   clone the two slots + symlink, build blue            (one-time, as you)
#   install      render + install both LaunchDaemons (sudo for those bits)
#   reinstall    re-render + re-bootstrap (after editing a plist)      (sudo bits)
#   uninstall    bootout + remove both daemons                        (sudo bits)
#   restart      kill the server so KeepAlive respawns it             (no sudo)
#   status       are the daemons loaded? is /health up? recent deploys?
#   logs         tail the server + deploy logs
#   render <server|deploy>   print a rendered plist (debug)
#
# Run this AS YOUR USER, never `sudo deploy-ctl.sh …` — it sudo's only the launchctl/cp
# lines itself. Running the whole thing as root would resolve $HOME to /var/root and
# render broken plists. See deploy/DEPLOY.md.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "Run as your user, not root — I sudo only the privileged bits myself." >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
LIVE_LINK="$HOME/pilot-live"
BLUE_DIR="$HOME/pilot-blue"
GREEN_DIR="$HOME/pilot-green"
LOG_DIR="$HOME/Library/Logs"
DATA_DIR="${PILOT_DATA_DIR:-$HOME/.local/state/pilot}"
ENV_FILE="$DATA_DIR/pilot.env"
LAUNCH_DAEMONS="/Library/LaunchDaemons"

SERVER_LABEL="com.pilot.server"
DEPLOY_LABEL="com.pilot.deploy"

render_plist() { # $1 = template path
  sed -e "s|@@LIVE@@|$LIVE_LINK|g" \
      -e "s|@@HOME@@|$HOME|g" \
      -e "s|@@USER@@|$USER_NAME|g" \
      -e "s|@@LOGDIR@@|$LOG_DIR|g" \
      "$1"
}

template_for() { # $1 = label  ->  echoes the template path
  case "$1" in
    "$SERVER_LABEL") echo "$REPO/deploy/com.pilot.server.plist" ;;
    "$DEPLOY_LABEL") echo "$REPO/deploy/com.pilot.deploy.plist" ;;
    *) echo "unknown label: $1" >&2; return 1 ;;
  esac
}

install_one() { # $1 = label
  local label="$1" src dest tmp
  src="$(template_for "$label")"
  dest="$LAUNCH_DAEMONS/$label.plist"
  tmp="$(mktemp -t pilot-plist)"
  render_plist "$src" > "$tmp"
  plutil -lint "$tmp" >/dev/null   # lints by content, extension-agnostic
  sudo cp "$tmp" "$dest"
  sudo chown root:wheel "$dest"
  sudo chmod 644 "$dest"
  rm -f "$tmp"
  sudo launchctl bootout "system/$label" 2>/dev/null || true
  sudo launchctl bootstrap system "$dest"
  echo "  installed $label"
}

cmd_setup_live() {
  [[ ! -e "$BLUE_DIR"  ]] || { echo "$BLUE_DIR already exists"  >&2; exit 1; }
  [[ ! -e "$GREEN_DIR" ]] || { echo "$GREEN_DIR already exists" >&2; exit 1; }
  [[ ! -e "$LIVE_LINK" ]] || { echo "$LIVE_LINK already exists" >&2; exit 1; }
  local remote
  remote="$(git -C "$REPO" remote get-url origin)"
  echo "Cloning $remote into both slots…"
  git clone "$remote" "$BLUE_DIR"
  git clone "$remote" "$GREEN_DIR"
  ( cd "$BLUE_DIR" && bun install && bun run build )
  ln -sfn "$BLUE_DIR" "$LIVE_LINK"
  mkdir -p "$DATA_DIR"
  echo
  echo "Slots ready: $LIVE_LINK -> $BLUE_DIR (built)."
  echo "Next:"
  echo "  1. create $ENV_FILE (chmod 600) with PILOT_TOKEN + PILOT_VAPID_SUBJECT"
  echo "  2. $0 install      # installs both daemons (sudo)"
  echo "  3. tailscale serve --bg ${PILOT_PORT:-8787}"
}

cmd_install() {
  [[ -L "$LIVE_LINK" ]] || { echo "no $LIVE_LINK — run '$0 setup-live' first" >&2; exit 1; }
  [[ -f "$ENV_FILE"  ]] || echo "WARNING: $ENV_FILE missing — server will run tokenless until you create it" >&2
  echo "Installing daemons (you'll be asked for sudo)…"
  install_one "$SERVER_LABEL"
  install_one "$DEPLOY_LABEL"
  echo "Done. '$0 status' to check."
}

cmd_uninstall() {
  for label in "$DEPLOY_LABEL" "$SERVER_LABEL"; do
    sudo launchctl bootout "system/$label" 2>/dev/null || true
    sudo rm -f "$LAUNCH_DAEMONS/$label.plist"
    echo "  removed $label"
  done
}

cmd_restart() {
  local pid
  pid="$( [[ -f "$DATA_DIR/pilot.pid" ]] && tr -d '[:space:]' < "$DATA_DIR/pilot.pid" || true )"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "killed server pid $pid — KeepAlive will respawn from $(readlink "$LIVE_LINK")"
  else
    pkill -U "$(id -u)" -f 'bun run src/index.ts' 2>/dev/null \
      && echo "killed server by match — KeepAlive will respawn" \
      || echo "no running server found (KeepAlive should start one)"
  fi
}

cmd_status() {
  for label in "$SERVER_LABEL" "$DEPLOY_LABEL"; do
    if launchctl print "system/$label" >/dev/null 2>&1; then
      echo "$label: loaded"
    else
      echo "$label: NOT loaded"
    fi
  done
  echo -n "live slot: "; readlink "$LIVE_LINK" 2>/dev/null || echo "(no symlink)"
  if curl -fsS --max-time 3 "http://127.0.0.1:${PILOT_PORT:-8787}/health" >/dev/null 2>&1; then
    echo "health: ok (:${PILOT_PORT:-8787})"
  else
    echo "health: DOWN (:${PILOT_PORT:-8787})"
  fi
  if [[ -f "$LOG_DIR/pilot-deploy-events.jsonl" ]]; then
    echo "recent deploy events:"; tail -n 5 "$LOG_DIR/pilot-deploy-events.jsonl"
  fi
}

cmd_logs() {
  touch "$LOG_DIR/pilot.err.log" "$LOG_DIR/pilot-deploy.log" 2>/dev/null || true
  tail -n 40 -f "$LOG_DIR/pilot.out.log" "$LOG_DIR/pilot.err.log" "$LOG_DIR/pilot-deploy.log"
}

cmd_render() {
  case "${1:-}" in
    server) render_plist "$(template_for "$SERVER_LABEL")" ;;
    deploy) render_plist "$(template_for "$DEPLOY_LABEL")" ;;
    *) echo "render <server|deploy>" >&2; exit 1 ;;
  esac
}

case "${1:-}" in
  setup-live) cmd_setup_live ;;
  install)    cmd_install ;;
  reinstall)  cmd_install ;;
  uninstall)  cmd_uninstall ;;
  restart)    cmd_restart ;;
  status)     cmd_status ;;
  logs)       cmd_logs ;;
  render)     cmd_render "${2:-}" ;;
  *) echo "usage: $0 {setup-live|install|reinstall|uninstall|restart|status|logs|render <server|deploy>}" >&2; exit 1 ;;
esac
