#!/usr/bin/env bash
# bootstrap-headless.sh — one-time bootstrap for the headless pantoken server.
#
# Renders the LaunchDaemon plist template from deploy/com.pantoken.server.plist,
# creates the versioned release layout under ~/pantoken-versions, installs the
# live symlink, writes the env file, and installs the LaunchDaemon.
#
# Usage:
#   bash deploy/bootstrap-headless.sh <version> <archive-path> [--user <name>]
#
#   <version>    — release version string (e.g. 1.2.3)
#   <archive>    — path to the extracted release payload directory
#   --user       — runtime user (default: current user)
#
# Prerequisites:
#   - A signed, extracted headless release archive (produced by CI or manual build)
#   - The user has a sudoers entry:
#       <user> ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/com.pantoken.server
#
# This script does NOT modify Tailscale Serve, delete legacy files, or perform
# live cutover. It is idempotent and safe to run repeatedly.

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────
VERSION="${1:-}"
ARCHIVE="${2:-}"
if [[ $# -ge 2 ]]; then shift 2; elif [[ $# -gt 0 ]]; then shift; fi
USER_NAME="$(id -un 2>/dev/null || echo "$(whoami)")"
SKIP_PLIST=false
SKIP_ENV=false
SKIP_DAEMON=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)    USER_NAME="$2"; shift 2 ;;
    --skip-plist)      SKIP_PLIST=true; shift ;;
    --skip-env)        SKIP_ENV=true; shift ;;
    --skip-daemon)     SKIP_DAEMON=true; shift ;;
    -h|--help)
      echo "Usage: $0 <version> <extracted-archive-dir> [options]" >&2
      echo "  --user <name>      runtime user (default: current user)" >&2
      echo "  --skip-plist       skip plist rendering/install" >&2
      echo "  --skip-env         skip env file creation" >&2
      echo "  --skip-daemon      skip daemon install (plist + launchctl)" >&2
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "ERROR: version is required" >&2
  exit 1
fi

if [[ -z "$ARCHIVE" ]]; then
  echo "ERROR: extracted archive directory is required" >&2
  exit 1
fi

if [[ ! -d "$ARCHIVE" ]]; then
  echo "ERROR: archive directory does not exist: $ARCHIVE" >&2
  exit 1
fi

# ── Resolve paths ─────────────────────────────────────────────────────────────
# Resolve the user's actual home directory (not just $HOME, which could be wrong
# if this runs via sudo or in a non-standard environment).
if [[ -n "$USER_NAME" ]]; then
  # Resolve the user's actual home directory.
  # Priority: 1) running as target user -> $HOME is authoritative;
  #            2) macOS dscacheutil;
  #            3) tilde expansion.
  RUNNING_USER="$(id -un 2>/dev/null || true)"
  if [[ "$RUNNING_USER" == "$USER_NAME" ]]; then
    HOME_DIR="$HOME"
  else
    HOME_DIR="$(dscacheutil -q user -a name "$USER_NAME" 2>/dev/null | awk '/^home:/{print $2}' || true)"
    if [[ -z "$HOME_DIR" ]] && command -v dscl >/dev/null 2>&1; then
      HOME_DIR="$(dscl . -read "/Users/${USER_NAME}" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    fi
  fi
  if [[ -z "$HOME_DIR" ]]; then
    echo "ERROR: cannot resolve home directory for user '$USER_NAME'" >&2
    exit 1
  fi
else
  echo "ERROR: --user is required when running as a different user" >&2
  exit 1
fi

LIVE_LINK="$HOME_DIR/pantoken-live"
VERSIONS_DIR="$HOME_DIR/pantoken-versions"
LIVE_DIR="$VERSIONS_DIR/$VERSION"
LOG_DIR="$HOME_DIR/Library/Logs/pantoken"
DATA_DIR="$HOME_DIR/.local/state/pantoken"
ENV_FILE="$DATA_DIR/pantoken.env"
PLIST_TEMPLATE="$(cd "$(dirname "$0")" && pwd)/com.pantoken.server.plist"
PLIST_DEST="/Library/LaunchDaemons/com.pantoken.server.plist"

# ── Validate archive contents ────────────────────────────────────────────────
# The archive must contain the canonical release layout.
validate_archive() {
  local dir="$1"
  local errors=0

  [[ -f "$dir/VERSION" ]] || { echo "  ✗ missing VERSION"; ((errors++)); }
  [[ -f "$dir/BUILD_SHA" ]] || { echo "  ✗ missing BUILD_SHA"; ((errors++)); }
  [[ -x "$dir/bin/pantoken-server" ]] || { echo "  ✗ missing or non-executable bin/pantoken-server"; ((errors++)); }
  [[ -x "$dir/run.sh" ]] || { echo "  ✗ missing or non-executable run.sh"; ((errors++)); }
  [[ -x "$dir/update.sh" ]] || { echo "  ✗ missing or non-executable update.sh"; ((errors++)); }
  [[ -f "$dir/client-dist/index.html" ]] || { echo "  ✗ missing client-dist/index.html"; ((errors++)); }

  # Check VERSION file matches the argument.
  if [[ -f "$dir/VERSION" ]]; then
    local archive_version
    archive_version="$(tr -d '[:space:]' < "$dir/VERSION")"
    if [[ "$archive_version" != "$VERSION" ]]; then
      echo "  ✗ VERSION file says '$archive_version', expected '$VERSION'" >&2
      ((errors++))
    fi
  fi

  if [[ $errors -gt 0 ]]; then
    echo "Archive validation failed ($errors errors)" >&2
    return 1
  fi

  echo "Archive validated ✓"
}

# ── Render plist ──────────────────────────────────────────────────────────────
render_plist() {
  local dest="$1"
  # Use sed to replace @@PLACEHOLDER@@ tokens with absolute paths.
  # Note: deploy/com.pantoken.server.plist uses @@@PLACEHOLDER@@@ to avoid
  # collisions with regular XML content.
  sed \
    -e "s|@@@USER@@@|$USER_NAME|g" \
    -e "s|@@@HOME@@@|$HOME_DIR|g" \
    -e "s|@@@LIVE@@@|$LIVE_DIR|g" \
    -e "s|@@@LOGDIR@@@|$LOG_DIR|g" \
    -e "s|@@@POLYTOKEN_BIN@@@|/usr/local/bin/polytoken|g" \
    -e "s|@@@XDG_CONFIG@@@|$HOME_DIR/.config|g" \
    -e "s|@@@XDG_DATA@@@|$HOME_DIR/.local/share|g" \
    "$PLIST_TEMPLATE"
}

# ── Install env file ──────────────────────────────────────────────────────────
install_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    echo "Env file already exists at $ENV_FILE (skipping creation)"
    return 0
  fi

  mkdir -p "$DATA_DIR"
  : > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created env file at $ENV_FILE (chmod 600)"
}

# ── Install LaunchDaemon ──────────────────────────────────────────────────────
install_plist() {
  local tmp
  tmp="$(mktemp -t pantoken-plist.XXXXXX)"
  render_plist "$tmp" > "$tmp.rendered"

  # Lint the rendered plist before installing.
  if ! plutil -lint "$tmp.rendered" 2>&1; then
    echo "Rendered plist failed linter. Contents:" >&2
    cat "$tmp.rendered" >&2
    rm -f "$tmp" "$tmp.rendered"
    return 1
  fi

  # Boot out old label if it exists, then install.
  sudo launchctl bootout "system/com.pantoken.server" 2>/dev/null || true
  sudo cp "$tmp.rendered" "$PLIST_DEST"
  sudo chown root:wheel "$PLIST_DEST"
  sudo chmod 644 "$PLIST_DEST"
  sudo launchctl bootstrap system "$PLIST_DEST"

  rm -f "$tmp" "$tmp.rendered"
  echo "Installed LaunchDaemon at $PLIST_DEST"
}

# ── Main ───────────────────────────────────────────────────────────────────────
echo "=== Pantoken headless bootstrap ==="
echo "  Version:   $VERSION"
echo "  User:      $USER_NAME"
echo "  Home:      $HOME_DIR"
echo "  Live dir:  $LIVE_DIR"
echo "  Archive:   $ARCHIVE"
echo ""

# Step 1: Validate archive.
echo "Step 1: Validating archive…"
if ! validate_archive "$ARCHIVE"; then
  echo "Aborting — archive is invalid." >&2
  exit 1
fi

# Step 2: Create version directory and install release contents.
echo "Step 2: Installing release to $LIVE_DIR…"
if [[ -d "$LIVE_DIR" ]]; then
  echo "  Version directory already exists ($LIVE_DIR) — skipping copy"
else
  mkdir -p "$LIVE_DIR"
  # Copy archive contents, preserving the directory layout.
  cp -R "$ARCHIVE/"* "$LIVE_DIR/"
  cp -R "$ARCHIVE"/.* "$LIVE_DIR/" 2>/dev/null || true
  echo "  Installed release to $LIVE_DIR"
fi

# Step 3: Create/update live symlink (atomic).
echo "Step 3: Setting up live symlink…"
mkdir -p "$VERSIONS_DIR"
if [[ -L "$LIVE_LINK" ]]; then
  live_old="$(readlink "$LIVE_LINK")"
  /bin/mv -f "$LIVE_LINK" "${LIVE_LINK}.tmp.$$"
  /bin/mv -f "${LIVE_LINK}.tmp.$$" "$LIVE_LINK" 2>/dev/null || true
  # Fallback: use ln -sfn for non-atomic flip.
  ln -sfn "$LIVE_DIR" "$LIVE_LINK"
  echo "  Updated live symlink: $LIVE_LINK -> $LIVE_DIR (was $live_old)"
elif [[ -e "$LIVE_LINK" ]]; then
  echo "ERROR: $LIVE_LINK exists but is not a symlink" >&2
  exit 1
else
  ln -sfn "$LIVE_DIR" "$LIVE_LINK"
  echo "  Created live symlink: $LIVE_LINK -> $LIVE_DIR"
fi

# Step 4: Install env file (idempotent).
if [[ "$SKIP_ENV" == false ]]; then
  echo "Step 4: Environment file…"
  install_env_file
fi

# Step 5: Install plist and daemon.
if [[ "$SKIP_PLIST" == false ]]; then
  echo "Step 5: Installing LaunchDaemon…"
  mkdir -p "$LOG_DIR"
  if [[ "$SKIP_DAEMON" == true ]]; then
    # Render to a temp file for inspection but don't install.
    local_tmp="$(mktemp -t pantoken-plist.XXXXXX)"
    render_plist "$local_tmp" > "$local_tmp.rendered"
    plutil -lint "$local_tmp.rendered" 2>&1
    echo "Rendered plist (not installed — --skip-daemon):" >&2
    cat "$local_tmp.rendered" >&2
    rm -f "$local_tmp" "$local_tmp.rendered"
  else
    install_plist
  fi
fi

echo ""
echo "Bootstrap complete."
echo "  To verify: launchctl print system/com.pantoken.server"
echo "  To check health: curl -fsS http://127.0.0.1:8787/health"
