#!/usr/bin/env bash
# bootstrap-tar-validator.sh — one-time installation of the tar validation binary.
#
# Installs a separately built and tested tar-validator executable at a fixed,
# trusted location. The validator is used by update-headless.sh (rendered as
# update.sh in release artifacts) before extraction to reject unsafe tar members.
#
# Usage:
#   sudo bash deploy/bootstrap-tar-validator.sh --binary <path-to-validator> --sha256 <64-char-lowercase-hex>
#
# Arguments:
#   --binary   — path to the operator-built validator executable (checked on the trusted build host)
#   --sha256   — SHA-256 digest of the binary (computed by the operator, not read from the binary)
#
# Installed files (root-owned):
#   /usr/local/libexec/pantoken-tar-validate       — the validator binary (mode 0755, root:wheel)
#   /usr/local/libexec/pantoken-tar-validate.sha256 — expected digest (mode 0644, root:wheel)
#
# This script NEVER reads a validator or digest from the untrusted archive,
# repository checkout, or user-writable override. The operator-supplied
# --sha256 argument is the installation authority.

set -euo pipefail

BINARY_PATH=""
SHA256_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary) [[ $# -ge 2 ]] || { echo "ERROR: --binary needs a path" >&2; exit 1; }; BINARY_PATH="$2"; shift 2 ;;
    --sha256) [[ $# -ge 2 ]] || { echo "ERROR: --sha256 needs a digest" >&2; exit 1; }; SHA256_ARG="$2"; shift 2 ;;
    *) echo "ERROR: unknown argument $1" >&2; exit 1 ;;
  esac
done
[[ -n "$BINARY_PATH" ]] || { echo "ERROR: --binary path is required" >&2; exit 1; }
[[ -n "$SHA256_ARG" ]] || { echo "ERROR: --sha256 digest is required" >&2; exit 1; }

# ── Validate arguments ────────────────────────────────────────────────────────
if [[ ! -f "$BINARY_PATH" ]]; then
  echo "ERROR: binary does not exist: $BINARY_PATH" >&2
  exit 1
fi

if [[ ! -x "$BINARY_PATH" ]]; then
  echo "ERROR: binary is not executable: $BINARY_PATH" >&2
  exit 1
fi

# Validate SHA-256 format: must be exactly 64 lowercase hex characters.
if [[ ! "$SHA256_ARG" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: SHA-256 must be exactly 64 lowercase hex characters, got: '$SHA256_ARG'" >&2
  exit 1
fi

# ── Require root ───────────────────────────────────────────────────────────────
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: must run as root (use sudo)" >&2
  exit 1
fi

# ── Compute and verify digest ─────────────────────────────────────────────────
COMPUTED_SHA256="$(shasum -a 256 "$BINARY_PATH" | awk '{print $1}')"
if [[ "$COMPUTED_SHA256" != "$SHA256_ARG" ]]; then
  echo "ERROR: digest mismatch" >&2
  echo "  Expected: $SHA256_ARG" >&2
  echo "  Computed: $COMPUTED_SHA256" >&2
  echo "  Source:   $BINARY_PATH" >&2
  exit 1
fi

# ── Install ────────────────────────────────────────────────────────────────────
INSTALL_DIR="${HOME}/.local/libexec"
INSTALL_BIN="$INSTALL_DIR/pantoken-tar-validate"
INSTALL_SHA="$INSTALL_DIR/pantoken-tar-validate.sha256"

mkdir -p "$INSTALL_DIR"

# Atomic install of the binary.
INSTALL_TMP_BIN="$(mktemp -p "$INSTALL_DIR" pantoken-tar-validate.XXXXXX)"
cp "$BINARY_PATH" "$INSTALL_TMP_BIN"
chmod 0755 "$INSTALL_TMP_BIN"
chown root:wheel "$INSTALL_TMP_BIN"
mv -f "$INSTALL_TMP_BIN" "$INSTALL_BIN"

# Atomic install of the digest record.
INSTALL_TMP_SHA="$(mktemp -p "$INSTALL_DIR" pantoken-tar-validate.sha256.XXXXXX)"
echo "$SHA256_ARG" > "$INSTALL_TMP_SHA"
chmod 0644 "$INSTALL_TMP_SHA"
chown root:wheel "$INSTALL_TMP_SHA"
mv -f "$INSTALL_TMP_SHA" "$INSTALL_SHA"

echo "Installed tar validator:"
echo "  Binary:   $INSTALL_BIN ($COMPUTED_SHA256)"
echo "  Digest:   $INSTALL_SHA"
echo "  Mode:     0755 (binary), 0644 (digest)"
echo ""
echo "Verify: $INSTALL_BIN /dev/null 2>&1 || true"
echo "Check digest: cat $INSTALL_SHA"
