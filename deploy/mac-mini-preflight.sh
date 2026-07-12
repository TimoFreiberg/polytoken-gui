#!/usr/bin/env bash
# mac-mini-preflight.sh — verify prerequisites and set up new-infra layout.
#
# Read-only checks first; setup only after all checks pass.
# Does NOT perform cutover or delete legacy state.
#
# Usage:
#   bash deploy/mac-mini-preflight.sh [--setup] [--version <ver>] [--archive <path>] [--force]
#
#   --setup       create the versioned layout + env file + render plist (does not install daemon)
#   --version     release version (required with --setup)
#   --archive     extracted payload directory (required with --setup)
#   --force       replace an existing pantoken-live symlink that points to a different version
#
# Check severity model:
#   fatal          — aborts the script
#   warning        — prints but continues
#   informational  — reports state without judgment
#
# Command seams for testability:
#   UNAME_BIN, TAILSCALE_BIN, LAUNCHCTL_BIN, PLUTIL_BIN, SUDO_BIN,
#   LSOF_BIN, POLYTOKEN_BIN — default to standard PATH, overridable for tests.
#
# Output: every check prints ✓ (pass), ⚠ (warning), ℹ (informational),
# or ✗ (fatal/fail) with details.

set -euo pipefail

# ── Command seams (overridable for tests) ─────────────────────────────────────
UNAME_BIN="${UNAME_BIN:-uname}"
TAILSCALE_BIN="${TAILSCALE_BIN:-tailscale}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
PLUTIL_BIN="${PLUTIL_BIN:-plutil}"
SUDO_BIN="${SUDO_BIN:-sudo}"
LSOF_BIN="${LSOF_BIN:-lsof}"
POLYTOKEN_BIN="${POLYTOKEN_BIN:-polytoken}"

# ── Paths ──────────────────────────────────────────────────────────────────────
HOME_DIR="${HOME}"
VERSIONS_DIR="$HOME_DIR/pantoken-versions"
LIVE_LINK="$HOME_DIR/pantoken-live"
DATA_DIR="$HOME_DIR/.local/state/pantoken"
ENV_FILE="$DATA_DIR/pantoken.env"
LOG_DIR="$HOME_DIR/Library/Logs/pantoken"
TRUSTED_VALIDATOR="$HOME_DIR/.local/libexec/pantoken-tar-validate"
PLIST_TEMPLATE="$(cd "$(dirname "$0")" && pwd)/com.pantoken.server.plist"
LAUNCHD_LABEL="com.pantoken.server"

# ── Argument parsing ───────────────────────────────────────────────────────────
DO_SETUP=false
SETUP_VERSION=""
SETUP_ARCHIVE=""
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup)   DO_SETUP=true; shift ;;
    --version) SETUP_VERSION="$2"; shift 2 ;;
    --archive) SETUP_ARCHIVE="$2"; shift 2 ;;
    --force)   FORCE=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--setup] [--version <ver>] [--archive <path>] [--force]"
      echo "  --setup       create the versioned layout + env file + render plist"
      echo "  --version     release version (required with --setup)"
      echo "  --archive     extracted payload directory (required with --setup)"
      echo "  --force       replace an existing pantoken-live symlink pointing elsewhere"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
fatal_count=0
warning_count=0

check_pass()   { printf '  ✓ %s\n' "$1"; }
check_warn()    { printf '  ⚠ %s\n' "$1"; warning_count=$((warning_count + 1)); }
check_info()    { printf '  ℹ %s\n' "$1"; }
check_fail()    { printf '  ✗ %s\n' "$1"; fatal_count=$((fatal_count + 1)); }

# ── Validate setup args ────────────────────────────────────────────────────────
if [[ "$DO_SETUP" == true ]]; then
  if [[ -z "$SETUP_VERSION" ]]; then
    echo "ERROR: --version is required with --setup" >&2
    exit 1
  fi
  if [[ -z "$SETUP_ARCHIVE" ]]; then
    echo "ERROR: --archive is required with --setup" >&2
    exit 1
  fi
  if [[ ! -d "$SETUP_ARCHIVE" ]]; then
    echo "ERROR: archive directory does not exist: $SETUP_ARCHIVE" >&2
    exit 1
  fi
fi

# ── Read-only checks ──────────────────────────────────────────────────────────
echo "=== Pantoken Mac Mini Preflight ==="
echo "  Mode: $([[ "$DO_SETUP" == true ]] && echo 'setup' || echo 'read-only')"
echo ""

echo "--- Check 1: Platform ---"
uname_s="$("$UNAME_BIN" -s 2>/dev/null || echo unknown)"
uname_m="$("$UNAME_BIN" -m 2>/dev/null || echo unknown)"
if [[ "$uname_s" == "Darwin" && "$uname_m" == "arm64" ]]; then
  check_pass "macOS arm64 ($uname_s $uname_m)"
else
  check_fail "expected Darwin arm64, found $uname_s $uname_m"
fi

echo "--- Check 2: polytoken daemon ---"
poly_ver="$("$POLYTOKEN_BIN" --version 2>/dev/null || true)"
if [[ -n "$poly_ver" ]]; then
  # Parse version: extract major.minor.patch from the output
  poly_ver_num="$(echo "$poly_ver" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -n "$poly_ver_num" ]]; then
    poly_major="$(echo "$poly_ver_num" | cut -d. -f1)"
    poly_minor="$(echo "$poly_ver_num" | cut -d. -f2)"
    if [[ "$poly_major" -gt 0 || ("$poly_major" -eq 0 && "$poly_minor" -ge 5) ]]; then
      check_pass "polytoken $poly_ver_num ($poly_ver)"
    else
      check_fail "polytoken $poly_ver_num < 0.5.0"
    fi
  else
    check_warn "polytoken found but version unparseable: $poly_ver"
  fi
else
  check_fail "polytoken not found or --version failed"
fi

echo "--- Check 3: polytoken path ---"
poly_path="$(command -v "$POLYTOKEN_BIN" 2>/dev/null || true)"
if [[ -n "$poly_path" ]]; then
  if [[ "$poly_path" == "/usr/local/bin/polytoken" || "$poly_path" == "/opt/homebrew/bin/polytoken" ]]; then
    check_pass "polytoken at $poly_path"
  else
    check_warn "polytoken at unexpected path: $poly_path"
  fi
else
  check_warn "polytoken not in PATH"
fi

echo "--- Check 4: Tailscale Serve ---"
if command -v "$TAILSCALE_BIN" >/dev/null 2>&1; then
  ts_status="$("$TAILSCALE_BIN" serve status 2>/dev/null || true)"
  if echo "$ts_status" | grep -q '127.0.0.1:8787'; then
    check_pass "Tailscale Serve proxies to 127.0.0.1:8787"
  else
    if [[ "$DO_SETUP" == true ]]; then
      check_fail "Tailscale Serve not proxying to 127.0.0.1:8787"
    else
      check_warn "Tailscale Serve not proxying to 127.0.0.1:8787"
    fi
  fi
else
  check_warn "tailscale CLI not found — cannot verify Serve config"
fi

echo "--- Check 5: Existing service ---"
if "$LAUNCHCTL_BIN" print "system/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  svc_status="$("$LAUNCHCTL_BIN" print "system/$LAUNCHD_LABEL" 2>/dev/null | head -5 || true)"
  check_info "service already loaded: $(echo "$svc_status" | tr '\n' ' ')"
else
  check_info "service not loaded (expected before bootstrap)"
fi

echo "--- Check 6: Port 8787 ---"
if "$LSOF_BIN" -i :8787 >/dev/null 2>&1; then
  port_info="$("$LSOF_BIN" -i :8787 2>/dev/null | head -3 || true)"
  check_info "something is listening on port 8787: $(echo "$port_info" | tr '\n' ' ')"
else
  check_info "port 8787 is free"
fi

echo "--- Check 7: Existing layout ---"
[[ -L "$LIVE_LINK" ]] && check_info "$LIVE_LINK → $(readlink "$LIVE_LINK")" || check_info "$LIVE_LINK does not exist"
[[ -d "$VERSIONS_DIR" ]] && check_info "$VERSIONS_DIR exists" || check_info "$VERSIONS_DIR does not exist"
[[ -f "$ENV_FILE" ]] && check_info "$ENV_FILE exists" || check_info "$ENV_FILE does not exist"

echo "--- Check 8: Trusted validator ---"
if [[ -x "$TRUSTED_VALIDATOR" ]]; then
  if [[ -f "${TRUSTED_VALIDATOR}.sha256" ]]; then
    expected="$(tr -d '[:space:]' < "${TRUSTED_VALIDATOR}.sha256")"
    actual="$(shasum -a 256 "$TRUSTED_VALIDATOR" | awk '{print $1}')"
    if [[ "$expected" == "$actual" ]]; then
      check_pass "trusted validator digest matches"
    else
      check_warn "trusted validator digest mismatch"
    fi
  else
    check_warn "trusted validator exists but no .sha256 digest record"
  fi
else
  check_warn "trusted validator not found at $TRUSTED_VALIDATOR"
fi

echo "--- Check 9: Sudoers ---"
if "$SUDO_BIN" -n -l "/bin/launchctl kickstart -k system/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  check_pass "sudoers allows kickstart -k system/$LAUNCHD_LABEL"
else
  if [[ "$DO_SETUP" == true ]]; then
    check_fail "sudoers does not allow kickstart -k system/$LAUNCHD_LABEL"
  else
    check_warn "sudoers does not allow kickstart -k system/$LAUNCHD_LABEL"
  fi
fi

echo "--- Check 10: Env file ---"
if [[ -f "$ENV_FILE" ]]; then
  env_mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
  has_token="$(grep -c '^PANTOKEN_TOKEN=' "$ENV_FILE" 2>/dev/null || echo 0)"
  has_bin="$(grep -c '^PANTOKEN_POLYTOKEN_BIN=' "$ENV_FILE" 2>/dev/null || echo 0)"
  # Check for shell metacharacters in values (run.sh rejects these)
  unsafe_values="$(grep -E '[$(`;&|]' "$ENV_FILE" 2>/dev/null | head -1 || true)"
  if [[ "$env_mode" != "600" ]]; then
    if [[ "$DO_SETUP" == true ]]; then
      check_fail "env file mode is $env_mode (expected 0600)"
    else
      check_warn "env file mode is $env_mode (expected 0600)"
    fi
  elif [[ "$has_token" -eq 0 || "$has_bin" -eq 0 ]]; then
    if [[ "$DO_SETUP" == true ]]; then
      check_fail "env file missing required keys (PANTOKEN_TOKEN or PANTOKEN_POLYTOKEN_BIN)"
    else
      check_warn "env file missing required keys"
    fi
  elif [[ -n "$unsafe_values" ]]; then
    if [[ "$DO_SETUP" == true ]]; then
      check_fail "env file contains unsafe shell metacharacters"
    else
      check_warn "env file contains unsafe shell metacharacters"
    fi
  else
    check_pass "env file valid (mode 0600, required keys present, safe values)"
  fi
else
  check_info "env file does not exist yet"
fi

echo ""
echo "=== Check summary ==="
echo "  Fatal: $fatal_count  Warnings: $warning_count"
echo ""

# ── Abort on fatal if setup mode ───────────────────────────────────────────────
if [[ "$DO_SETUP" == true && $fatal_count -gt 0 ]]; then
  echo "ERROR: $fatal_count fatal check(s) failed — aborting setup" >&2
  exit 1
fi

# ── Setup mode ────────────────────────────────────────────────────────────────
if [[ "$DO_SETUP" != true ]]; then
  if [[ $fatal_count -gt 0 ]]; then
    exit 1
  fi
  exit 0
fi

echo "=== Setup mode ==="
echo ""

# ── Pre-mutation validation ───────────────────────────────────────────────────
echo "--- Step 1: Validate archive ---"
archive_errors=0
[[ -f "$SETUP_ARCHIVE/VERSION" ]] || { echo "  ✗ missing VERSION"; archive_errors=$((archive_errors+1)); }
[[ -f "$SETUP_ARCHIVE/BUILD_SHA" ]] || { echo "  ✗ missing BUILD_SHA"; archive_errors=$((archive_errors+1)); }
[[ -x "$SETUP_ARCHIVE/bin/pantoken-server" ]] || { echo "  ✗ missing or non-executable bin/pantoken-server"; archive_errors=$((archive_errors+1)); }
[[ -x "$SETUP_ARCHIVE/run.sh" ]] || { echo "  ✗ missing or non-executable run.sh"; archive_errors=$((archive_errors+1)); }
[[ -x "$SETUP_ARCHIVE/update.sh" ]] || { echo "  ✗ missing or non-executable update.sh"; archive_errors=$((archive_errors+1)); }
[[ -f "$SETUP_ARCHIVE/client-dist/index.html" ]] || { echo "  ✗ missing client-dist/index.html"; archive_errors=$((archive_errors+1)); }

if [[ -f "$SETUP_ARCHIVE/VERSION" ]]; then
  archive_version="$(tr -d '[:space:]' < "$SETUP_ARCHIVE/VERSION")"
  if [[ "$archive_version" != "$SETUP_VERSION" ]]; then
    echo "  ✗ VERSION file says '$archive_version', expected '$SETUP_VERSION'"
    archive_errors=$((archive_errors+1))
  fi
fi

if [[ $archive_errors -gt 0 ]]; then
  echo "ERROR: archive validation failed ($archive_errors errors)" >&2
  exit 1
fi
check_pass "archive validated"

echo "--- Step 2: Validate env requirements ---"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -z "${PANTOKEN_TOKEN:-}" ]]; then
    echo "ERROR: PANTOKEN_TOKEN env var is required to create a new env file" >&2
    exit 1
  fi
  if [[ -z "${PANTOKEN_POLYTOKEN_BIN:-}" ]]; then
    echo "ERROR: PANTOKEN_POLYTOKEN_BIN env var is required to create a new env file" >&2
    exit 1
  fi
  check_pass "env vars provided for new env file (token not echoed)"
else
  check_pass "env file already exists — preserving as-is"
fi

echo "--- Step 3: Stage and validate plist ---"
mkdir -p "$VERSIONS_DIR"
staging_dir="$(mktemp -d "${VERSIONS_DIR}/.preflight-staging-XXXXXX")"
rendered_plist="$staging_dir/com.pantoken.server.plist"

sed \
  -e "s|@@@USER@@@|$(id -un)|g" \
  -e "s|@@@HOME@@@|$HOME_DIR|g" \
  -e "s|@@@LIVE@@@|${VERSIONS_DIR}/${SETUP_VERSION}|g" \
  -e "s|@@@LOGDIR@@@|$LOG_DIR|g" \
  -e "s|@@@POLYTOKEN_BIN@@@|/usr/local/bin/polytoken|g" \
  -e "s|@@@XDG_CONFIG@@@|$HOME_DIR/.config|g" \
  -e "s|@@@XDG_DATA@@@|$HOME_DIR/.local/share|g" \
  "$PLIST_TEMPLATE" > "$rendered_plist"

if ! "$PLUTIL_BIN" -lint "$rendered_plist" 2>&1; then
  echo "ERROR: rendered plist failed lint" >&2
  rm -rf "$staging_dir"
  exit 1
fi
check_pass "rendered plist valid"

# Stage env file if it doesn't exist
staged_env=""
if [[ ! -f "$ENV_FILE" ]]; then
  staged_env="$staging_dir/pantoken.env"
  cat > "$staged_env" <<ENVEOF
PANTOKEN_TOKEN=${PANTOKEN_TOKEN}
PANTOKEN_POLYTOKEN_BIN=${PANTOKEN_POLYTOKEN_BIN}
ENVEOF
  chmod 600 "$staged_env"
  check_pass "staged env file (mode 0600)"
fi

echo "--- Step 4: Create version directory ---"
target_dir="$VERSIONS_DIR/$SETUP_VERSION"
if [[ -e "$target_dir" ]]; then
  echo "ERROR: version directory already exists: $target_dir" >&2
  rm -rf "$staging_dir"
  exit 1
fi
mkdir -p "$target_dir"
cp -R "$SETUP_ARCHIVE/"* "$target_dir/"
cp -R "$SETUP_ARCHIVE"/.* "$target_dir/" 2>/dev/null || true
check_pass "installed release to $target_dir"

echo "--- Step 5: Symlink ---"
if [[ -L "$LIVE_LINK" ]]; then
  current_target="$(readlink "$LIVE_LINK")"
  if [[ "$current_target" == "$target_dir" ]]; then
    check_pass "pantoken-live already points to $SETUP_VERSION (idempotent skip)"
  elif [[ "$FORCE" == true ]]; then
    ln -sfn "$target_dir" "$LIVE_LINK"
    check_warn "replaced pantoken-live: $current_target → $target_dir"
  else
    echo "ERROR: pantoken-live points to $current_target (expected $target_dir)" >&2
    echo "  Pass --force to replace" >&2
    rm -rf "$staging_dir"
    exit 1
  fi
elif [[ -e "$LIVE_LINK" ]]; then
  echo "ERROR: $LIVE_LINK exists but is not a symlink" >&2
  rm -rf "$staging_dir"
  exit 1
else
  ln -sfn "$target_dir" "$LIVE_LINK"
  check_pass "created pantoken-live → $target_dir"
fi

echo "--- Step 6: Install env file ---"
if [[ -n "$staged_env" ]]; then
  mkdir -p "$DATA_DIR"
  mv "$staged_env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  check_pass "installed env file (mode 0600)"
fi

# ── Preserve rendered plist for review, then clean up staging ──────────────
review_plist="${VERSIONS_DIR}/.preflight-rendered-plist.$$"
cp "$rendered_plist" "$review_plist" 2>/dev/null || true
rm -rf "$staging_dir"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Rendered plist (review before installing):"
echo "  $review_plist"
cat "$review_plist"
echo ""
echo "To install the daemon, run:"
echo "  sudo launchctl bootstrap system /Library/LaunchDaemons/com.pantoken.server.plist"
echo ""
echo "Post-setup verification:"
echo "  readlink ~/pantoken-live"
echo "  cat ~/pantoken-versions/$SETUP_VERSION/VERSION"
echo "  curl -fsS http://127.0.0.1:8787/health"
echo "  launchctl print system/$LAUNCHD_LABEL"
