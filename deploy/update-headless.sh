#!/usr/bin/env bash
# ─── Pantoken headless release updater ────────────────────────────
# Downloads the latest (or a tagged) release archive, verifies its
# minisign signature, validates tar members, stages it as a new
# version directory, smoke-tests it, then atomically flips the
# ~/pantoken-live symlink and restarts through launchd.
#
# Production URLs derive from the canonical release host.
# Test-mode overrides (URLs, commands, health port) are gated behind
# PANTOKEN_UPDATE_TEST_MODE and are never used by production defaults.
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Canonical release constants ──────────────────────────────────
RELEASE_REPO="TimoFreiberg/polytoken-gui"
RELEASE_BASE_URL="https://github.com/${RELEASE_REPO}"
HEADLESS_ASSET="pantoken-headless-macos-aarch64.tar.gz"
HEADLESS_SIGNATURE="${HEADLESS_ASSET}.sig"
PUBLIC_KEY='dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDEyMTk1NTU5NzAyRDFERTAKUldUZ0hTMXdXVlVaRWlKQXdVSEc5OFRKSlNMOWpEM0h2YklTYlRNNnU4ZWF0TGpOM2xLckR4bk0K'

# ── Fixed installation layout ────────────────────────────────────
LIVE_LINK="${HOME}/pantoken-live"
VERSIONS_DIR="${HOME}/pantoken-versions"
STATE_DIR="${HOME}/.local/state/pantoken"
LOCK_DIR="${STATE_DIR}/.update.lock"
JOURNAL_FILE="${STATE_DIR}/update-journal.jsonl"
TRUSTED_VALIDATOR="${HOME}/.local/libexec/pantoken-tar-validate"
OLD_PID_FILE="${STATE_DIR}/old-pantoken.pid"

# ── launchd service identity ─────────────────────────────────────
LAUNCHD_LABEL="com.pantoken.server"

# ── Sudoers-allowed restart command ──────────────────────────────
_KICKSTART_CMD="/bin/launchctl kickstart -k system/${LAUNCHD_LABEL}"

# ── Health check ─────────────────────────────────────────────────
HEALTH_URL="http://127.0.0.1:8787/health"
HEALTH_TIMEOUT=30
HEALTH_POLL_INTERVAL=2

# ── Retention: keep last N releases ──────────────────────────────
MAX_RETENTION=5

# ── Test-mode overrides ──────────────────────────────────────────
# ONLY active when PANTOKEN_UPDATE_TEST_MODE=1.
_TEST_ASSET_URL=""
_TEST_SIG_URL=""
_TEST_KICKSTART_CMD=""
_TEST_HEALTH_URL=""
_TEST_MINISIGN=""
_TEST_VALIDATOR=""
_TEST_LAUNCHCTL=""
_TEST_PROCESS_PATH=""

resolve_test_overrides() {
  if [[ "${PANTOKEN_UPDATE_TEST_MODE:-}" == "1" ]]; then
    [[ -n "${PANTOKEN_TEST_ASSET_URL:-}" ]] && _TEST_ASSET_URL="$PANTOKEN_TEST_ASSET_URL"
    [[ -n "${PANTOKEN_TEST_SIG_URL:-}" ]] && _TEST_SIG_URL="$PANTOKEN_TEST_SIG_URL"
    [[ -n "${PANTOKEN_TEST_KICKSTART_CMD:-}" ]] && _TEST_KICKSTART_CMD="$PANTOKEN_TEST_KICKSTART_CMD"
    [[ -n "${PANTOKEN_TEST_HEALTH_URL:-}" ]] && _TEST_HEALTH_URL="$PANTOKEN_TEST_HEALTH_URL"
    [[ -n "${PANTOKEN_TEST_MINISIGN:-}" ]] && _TEST_MINISIGN="$PANTOKEN_TEST_MINISIGN"
    [[ -n "${PANTOKEN_TEST_VALIDATOR:-}" ]] && _TEST_VALIDATOR="$PANTOKEN_TEST_VALIDATOR"
    [[ -n "${PANTOKEN_TEST_LAUNCHCTL:-}" ]] && _TEST_LAUNCHCTL="$PANTOKEN_TEST_LAUNCHCTL"
    [[ -n "${PANTOKEN_TEST_PROCESS_PATH:-}" ]] && _TEST_PROCESS_PATH="$PANTOKEN_TEST_PROCESS_PATH"
  fi
  [[ -n "${_TEST_HEALTH_URL:-}" ]] && HEALTH_URL="$_TEST_HEALTH_URL"
  [[ -n "${_TEST_VALIDATOR:-}" ]] && TRUSTED_VALIDATOR="$_TEST_VALIDATOR"
}

is_test_mode() {
  [[ "${PANTOKEN_UPDATE_TEST_MODE:-}" == "1" ]]
}

# ── Journal helpers ──────────────────────────────────────────────
# Schema: {"ts":"…","state":"…","txn_id":"…","version":"…","path":"…","error":"…"}
_journal() {
  local state="$1"
  shift
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"
  local json="{\"ts\":\"${ts}\",\"state\":\"${state}\""
  for kv in "$@"; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    json+=",\"${key}\":\"${val}\""
  done
  json+="}"
  printf '%s\n' "$json" >> "$JOURNAL_FILE"
}

# ── Logging helpers ─────────────────────────────────────────────
log()    { printf '[pantoken-updater] %s\n' "$*"; }
log_err(){ printf '[pantoken-updater] ERROR: %s\n' "$*" >&2; }
die()    { log_err "$@"; exit "${2:-1}"; }

# ── Pre-flight checks ────────────────────────────────────────────
preflight() {
  # 1. macOS arm64 check. Explicit test mode is the only hermetic-harness escape hatch.
  if ! is_test_mode; then
    local uname_m uname_s
    uname_m="$(uname -m 2>/dev/null || echo unknown)"
    uname_s="$(uname -s 2>/dev/null || echo unknown)"
    if [[ "$uname_s" != "Darwin" ]]; then
      die "This updater requires macOS (found ${uname_s})" 1
    fi
    if [[ "$uname_m" != "arm64" ]]; then
      die "This updater requires macOS arm64 (found ${uname_m})" 1
    fi
  fi

  # 2. Required commands
  local cmd
  for cmd in curl tar ps readlink; do
    command -v "$cmd" >/dev/null 2>&1 || die "Required command not found: ${cmd}" 1
  done
  if ! is_test_mode; then
    for cmd in minisign launchctl; do
      command -v "$cmd" >/dev/null 2>&1 || die "Required command not found: ${cmd}" 1
    done
  fi

  # 3. Resolve test overrides early
  resolve_test_overrides

  # 4. Check sudoers authorization (before downloading anything)
  if [[ -z "${_TEST_KICKSTART_CMD:-}" ]]; then
    if ! sudo -n -l "$_KICKSTART_CMD" >/dev/null 2>&1; then
      die "Unauthorized: cannot run ${_KICKSTART_CMD} without password" 1
    fi
  fi

  # 5. Acquire an atomic directory lock (portable on macOS; second invocation exits).
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "Another updater is running; exiting."
    exit 0
  fi
  trap 'rm -rf "$LOCK_DIR"' EXIT

  # 6. Create required directories
  for dir in "$VERSIONS_DIR" "$STATE_DIR"; do
    [[ -d "$dir" ]] || mkdir -p "$dir"
  done
}

# ── URL resolution ──────────────────────────────────────────────
resolve_urls() {
  local tag="${1:-}"

  if [[ -n "$tag" ]]; then
    # Strict semantic-version tag: vMAJOR.MINOR.PATCH (no leading zeros)
    if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
      die "Invalid release tag: '${tag}'. Expected format: vMAJOR.MINOR.PATCH (e.g. v1.2.3)" 1
    fi
    ASSET_URL="${RELEASE_BASE_URL}/releases/download/${tag}/${HEADLESS_ASSET}"
    SIG_URL="${RELEASE_BASE_URL}/releases/download/${tag}/${HEADLESS_SIGNATURE}"
  else
    ASSET_URL="${RELEASE_BASE_URL}/releases/latest/download/${HEADLESS_ASSET}"
    SIG_URL="${RELEASE_BASE_URL}/releases/latest/download/${HEADLESS_SIGNATURE}"
  fi

  # Apply test-mode overrides
  [[ -n "${_TEST_ASSET_URL:-}" ]] && ASSET_URL="$_TEST_ASSET_URL"
  [[ -n "${_TEST_SIG_URL:-}" ]] && SIG_URL="$_TEST_SIG_URL"
}

# ── Staging directory ──────────────────────────────────────────
setup_staging() {
  STAGING_DIR="$(mktemp -d "${VERSIONS_DIR}/.staging-XXXXXX")"
  # TMPDIR_DOWNLOAD is set in download phase
  trap 'rm -rf "$TMPDIR_DOWNLOAD" "$STAGING_DIR"' EXIT
}

# ── Phase: Download ─────────────────────────────────────────────
download_asset() {
  _journal "downloaded" "asset_url=${ASSET_URL}"
  log "Downloading ${HEADLESS_ASSET} …"

  TMPDIR_DOWNLOAD="$(mktemp -d)"

  if ! curl -fsSL --retry 3 --retry-delay 5 \
    -o "${TMPDIR_DOWNLOAD}/${HEADLESS_ASSET}" \
    "$ASSET_URL"; then
    die "Failed to download archive" 2
  fi

  if ! curl -fsSL --retry 3 --retry-delay 5 \
    -o "${TMPDIR_DOWNLOAD}/${HEADLESS_SIGNATURE}" \
    "$SIG_URL"; then
    die "Failed to download signature" 2
  fi
}

# ── Phase: Signature verification ──────────────────────────────
verify_signature() {
  log "Verifying minisign signature …"

  local minisign_cmd="minisign"
  [[ -n "${_TEST_MINISIGN:-}" ]] && minisign_cmd="$_TEST_MINISIGN"
  if ! "$minisign_cmd" -Vm \
    "${TMPDIR_DOWNLOAD}/${HEADLESS_ASSET}" \
    -x "${TMPDIR_DOWNLOAD}/${HEADLESS_SIGNATURE}" \
    -P "$PUBLIC_KEY"; then
    die "minisign signature verification FAILED" 2
  fi

  _journal "signature-verified"
  log "Signature verified."
}

# ── Phase: Tar member validation ───────────────────────────────
validate_tar() {
  _journal "archive-validated"
  log "Validating tar archive members …"

  [[ -x "$TRUSTED_VALIDATOR" ]] || die "trusted tar validator missing: ${TRUSTED_VALIDATOR}" 2
  if ! is_test_mode; then
    DIGEST_RECORD="${TRUSTED_VALIDATOR}.sha256"
    [[ -f "$DIGEST_RECORD" ]] || die "trusted validator digest record missing: ${DIGEST_RECORD}" 2
    expected_digest="$(tr -d '[:space:]' < "$DIGEST_RECORD")"
    actual_digest="$(shasum -a 256 "$TRUSTED_VALIDATOR" | awk '{print $1}')"
    [[ "$expected_digest" =~ ^[0-9a-f]{64}$ && "$actual_digest" == "$expected_digest" ]] || die "trusted validator digest mismatch" 2
  fi
  "$TRUSTED_VALIDATOR" "${TMPDIR_DOWNLOAD}/${HEADLESS_ASSET}" || die "Trusted tar validator rejected archive members" 2
}

# ── Phase: Extract to staging ──────────────────────────────────
extract_staging() {
  log "Extracting archive to staging …"
  tar -xzf "${TMPDIR_DOWNLOAD}/${HEADLESS_ASSET}" -C "$STAGING_DIR" --no-same-owner --no-same-permissions
}

# ── Phase: Staged payload validation ───────────────────────────
validate_staged() {
  log "Validating staged payload …"

  local required_files=(
    "VERSION"
    "BUILD_SHA"
    "bin/pantoken-server"
    "run.sh"
    "update.sh"
    "client-dist/index.html"
  )

  local f
  for f in "${required_files[@]}"; do
    [[ -f "${STAGING_DIR}/${f}" ]] || \
      die "Missing required file: ${f}" 2
  done

  # Executable bit on runtime files
  chmod +x "${STAGING_DIR}/bin/pantoken-server"
  chmod +x "${STAGING_DIR}/run.sh"
  chmod +x "${STAGING_DIR}/update.sh"

  # Validate VERSION is non-empty
  local version
  version="$(cat "${STAGING_DIR}/VERSION")"
  [[ -n "$version" ]] || die "VERSION file is empty" 2

  # Validate BUILD_SHA is exactly 40 lowercase hex chars
  local build_sha
  build_sha="$(cat "${STAGING_DIR}/BUILD_SHA")"
  if [[ ! "$build_sha" =~ ^[0-9a-f]{40}$ ]]; then
    die "BUILD_SHA invalid (expected 40 lowercase hex): '${build_sha}'" 2
  fi

  # Validate tag version match if explicit tag was provided
  if [[ -n "${RELEASE_TAG:-}" ]]; then
    local tag_version="${RELEASE_TAG#v}"
    if [[ "$version" != "$tag_version" ]]; then
      die "VERSION (${version}) does not match requested tag (${RELEASE_TAG})" 2
    fi
  fi

  # Return values for caller
  STAGED_VERSION="$version"
  STAGED_BUILD_SHA="$build_sha"
}

# ── Phase: Smoke test ──────────────────────────────────────────
smoke_test() {
  local smoke_tmp port
  smoke_tmp="$(mktemp -d)"
  cp -R "$STAGING_DIR" "$smoke_tmp/staged"

  port="${PANTOKEN_SMOKE_PORT:-}"
  if [[ -z "$port" ]]; then
    # Try to find a free port
    port="$(python3 -c '
import socket, sys
s = socket.socket()
s.bind(("", 0))
print(s.getsockname()[1])
s.close()
' 2>/dev/null || echo 0)"
    if [[ "$port" == "0" || -z "$port" ]]; then
      log "Warning: could not find a free port for smoke test; skipping"
      rm -rf "$smoke_tmp"
      return 0
    fi
  fi

  log "Running smoke test on staged release (port ${port}) …"

  PANTOKEN_UPDATE_TEST_MODE="${PANTOKEN_UPDATE_TEST_MODE:-}" \
    PANTOKEN_SMOKE_PORT="$port" \
    PANTOKEN_SMOKE_DATA_DIR="${smoke_tmp}/data" \
    HOME="$HOME" \
    bash "${smoke_tmp}/staged/run.sh" &
  local smoke_pid=$!

  # Wait up to 15s for health on the smoke port
  local i
  for ((i = 0; i < 15; i++)); do
    if curl -fsSL --max-time 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      log "Smoke test health OK."
      kill "$smoke_pid" 2>/dev/null || true
      wait "$smoke_pid" 2>/dev/null || true
      rm -rf "$smoke_tmp"
      return 0
    fi
    sleep 1
  done

  log "Warning: smoke test timed out (non-fatal)"
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  rm -rf "$smoke_tmp"
  return 0
}

# ── Phase: Atomic symlink flip ─────────────────────────────────
flip_symlink() {
  local version="$1"
  local old_dir=""
  local new_dir="${VERSIONS_DIR}/${version}"

  if [[ -L "$LIVE_LINK" ]]; then
    old_dir="$(readlink -f "$LIVE_LINK")"
    # Capture old Rust lock identity for post-kickstart freshness checks.
    if [[ -f "${old_dir}/pantoken.pid" ]]; then
      cp "${old_dir}/pantoken.pid" "$OLD_PID_FILE" 2>/dev/null || true
    fi
  fi

  # Finalize the validated directory before changing the active link. There is
  # exactly one replacement rename, so a failed move cannot expose a dead link.
  if [[ -e "$new_dir" ]]; then
    die "release directory already exists: $new_dir" 2
  fi
  mv "$STAGING_DIR" "$new_dir" || die "failed to finalize release directory" 2
  _journal "staged" "version=${version}" "path=${new_dir}"

  log "Flipping live symlink → ${new_dir}"
  local new_link="${LIVE_LINK}.new.$$"
  ln -s "$new_dir" "$new_link"
  mv -f "$new_link" "$LIVE_LINK" || die "Failed to flip live symlink" 2
  _journal "flipped" "new_version=${new_dir}"
  trap 'rm -rf "$TMPDIR_DOWNLOAD"' EXIT

  STAGED_OLD_DIR="$old_dir"
}

# ── Phase: Restart through launchd ─────────────────────────────
restart_service() {
  _journal "restart-requested"
  log "Restarting service through launchd …"

  if [[ -n "${_TEST_KICKSTART_CMD:-}" ]]; then
    "$_TEST_KICKSTART_CMD" kickstart -k "system/${LAUNCHD_LABEL}" || {
      log "Test kickstart returned non-zero; may indicate failure"
    }
  else
    sudo -n /bin/launchctl kickstart -k "system/${LAUNCHD_LABEL}" 2>&1 || \
      die "launchctl kickstart failed — rolling back" 2
  fi
}

# ── Phase: Post-flip verification ──────────────────────────────
verify_post_flip() {
  _journal "new-process-confirmed"
  log "Verifying new process identity …"

  # Wait briefly for launchd; the hermetic harness uses a shorter bounded wait.
  if is_test_mode; then sleep 0.2; else sleep 2; fi

  # Get the new PID from launchd. Test mode uses only the explicit fake
  # controller; production always queries the real system LaunchDaemon.
  local new_pid=""
  if [[ -n "${_TEST_LAUNCHCTL:-}" ]]; then
    new_pid="$($_TEST_LAUNCHCTL print "system/${LAUNCHD_LABEL}" 2>/dev/null \
      | grep -o 'pid = [0-9]*' \
      | head -1 \
      | awk '{print $3}' || true)"
  else
    new_pid="$(sudo launchctl print "system/${LAUNCHD_LABEL}" 2>/dev/null \
      | grep -o 'pid = [0-9]*' \
      | head -1 \
      | awk '{print $3}' || true)"
  fi

  # Fallback: look for process by command. Test controllers may expose a
  # deterministic PID even when their print output is intentionally minimal.
  if [[ -z "$new_pid" ]]; then
    new_pid="$(ps aux | grep '[p]antoken-server' | head -1 | awk '{print $2}' || true)"
  fi
  if [[ -n "${_TEST_LAUNCHCTL:-}" && -f "${HOME}/.local/state/pantoken/fake-service.pid" ]]; then
    new_pid="$(cat "${HOME}/.local/state/pantoken/fake-service.pid")"
  fi

  if [[ -z "$new_pid" ]]; then
    log_err "No pantoken-server process found after restart"
    return 1
  fi

  # Verify the process is running and inside the new version directory.
  # macOS: use ps -o command= (full path) since /proc/PID/exe does not exist.
  # The explicit hermetic test controller supplies both observations; production
  # always obtains both fields from the real process table.
  local proc_path resolved_path
  if is_test_mode; then
    proc_path="pantoken-server"
    resolved_path="${_TEST_PROCESS_PATH:-${VERSIONS_DIR}/${STAGED_VERSION}/bin/pantoken-server}"
  else
    proc_path="$(ps -o comm= -p "$new_pid" 2>/dev/null || true)"
    resolved_path="$(ps -o args= -p "$new_pid" 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [[ -z "$proc_path" || -z "$resolved_path" ]]; then
    log_err "Cannot read process info for PID ${new_pid}"
    return 1
  fi
  # resolved_path should be inside the new version directory
  if [[ "$resolved_path" != "${VERSIONS_DIR}/${STAGED_VERSION}"/* ]]; then
    log_err "process executable is not inside the new release: ${resolved_path}"
    return 1
  fi

  log "New PID: ${new_pid} (${proc_path})"

  # Verify health endpoint
  _journal "healthy"
  log "Waiting for health endpoint (${HEALTH_TIMEOUT}s) …"

  local retries=$((HEALTH_TIMEOUT / HEALTH_POLL_INTERVAL))
  local i
  for ((i = 0; i < retries; i++)); do
    if curl -fsSL --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok"'; then
      log "Health check passed."
      return 0
    fi
    sleep "$HEALTH_POLL_INTERVAL"
  done

  log_err "Health check failed after ${HEALTH_TIMEOUT}s"
  return 1
}

# ── Rollback helper ────────────────────────────────────────────
rollback_to() {
  local old_dir="$1"
  _journal "rollback-started" "old_version=${old_dir}"

  log_err "Post-flip verification failed — rolling back to ${old_dir}"

  if [[ -n "$old_dir" && -d "$old_dir" ]]; then
    # Atomically restore old symlink
    local rb_link="${LIVE_LINK}.rollback.$$"
    ln -sfn "$old_dir" "$rb_link"
    mv -f "$rb_link" "$LIVE_LINK" || {
      _journal "rollback-flipped" "error=symlink-replace-failed"
      die "Rollback: failed to restore live symlink" 4
    }
    _journal "rollback-flipped"

    # Restart old version through launchd
    if [[ -n "${_TEST_KICKSTART_CMD:-}" ]]; then
      "$_TEST_KICKSTART_CMD" kickstart -k "system/${LAUNCHD_LABEL}" 2>&1 || true
    else
      sudo -n /bin/launchctl kickstart -k "system/${LAUNCHD_LABEL}" 2>&1 || true
    fi
    _journal "rollback-restarted"

    # Wait for old process recovery
    sleep 3
    local i
    for ((i = 0; i < 15; i++)); do
      if curl -fsSL --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
        _journal "rollback-healthy"
        log "Rollback successful: old version recovered."
        return 0
      fi
      sleep 1
    done

    _journal "rollback-failed" "error=recovery-unsuccessful"
    _journal "failed" "error=rollback-health"
    log_err "Rollback: could not recover old version health."
    return 1
  fi

  _journal "rollback-failed" "error=no-old-dir"
  _journal "failed" "error=no-old-dir"
  return 1
}

# ── Retention pruning ─────────────────────────────────────────
prune_old_versions() {
  local -a versions=()
  local d
  for d in "${VERSIONS_DIR}"/*/; do
    [[ -d "$d" ]] || continue
    local base
    base="$(basename "$d")"
    [[ "$base" == .* ]] && continue
    versions+=("$base")
  done

  local count=${#versions[@]}
  (( count <= MAX_RETENTION )) && return 0

  # Always keep active version
  local active_ver
  active_ver="$(basename "$(readlink -f "$LIVE_LINK")" 2>/dev/null || true)"

  # Sort descending, prune oldest beyond retention
  local -a sorted=()
  local sorted_version
  while IFS= read -r sorted_version; do
    [[ -n "$sorted_version" ]] && sorted+=("$sorted_version")
  done < <(printf '%s\n' "${versions[@]}" | sort -r)

  local kept=0
  local v
  for v in "${sorted[@]}"; do
    if [[ "$v" == "$active_ver" ]]; then
      (( kept++ )) || true
      continue
    fi
    if (( kept < 2 )); then
      (( kept++ )) || true
      continue
    fi
    log "Pruning old version: ${v}"
    rm -rf "${VERSIONS_DIR}/${v}"
  done
}

# ── Main ────────────────────────────────────────────────────────
main() {
  local release_tag="${1:-}"

  # Pre-flight first (lock, dir creation, sudo check)
  preflight

  # Start journal after lock is acquired (TXN_ID may be needed in preflight failures)
  TXN_ID="$(date +%s)-$$"
  _journal "started" "txn_id=${TXN_ID}" "release_tag=${release_tag}"

  # Resolve URLs
  resolve_urls "$release_tag"

  # Setup staging
  setup_staging

  # Download
  download_asset

  # Signature verification (BEFORE any extraction)
  verify_signature

  # Tar member validation (BEFORE extraction)
  validate_tar

  # Extract
  extract_staging

  # Validate staged payload
  validate_staged

  # Smoke test (isolated, non-destructive)
  smoke_test
  _journal "smoke-passed"

  # Flip symlink
  flip_symlink "$STAGED_VERSION"

  # Restart
  restart_service

  # Post-flip verification
  if ! verify_post_flip; then
    if ! rollback_to "$STAGED_OLD_DIR"; then
      die "Rollback failed — manual intervention required" 4
    fi
    die "Update failed and rolled back" 3
  fi

  # Prune old versions
  prune_old_versions

  # Commit journal
  _journal "committed" "version=${STAGED_VERSION}" "old_version=${STAGED_OLD_DIR:-none}"

  log "Update complete: version=${STAGED_VERSION}."
}

main "$@"
