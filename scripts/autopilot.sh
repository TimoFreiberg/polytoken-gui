#!/usr/bin/env bash
# autopilot.sh — entry point for the autonomous GitHub issue implementation loop.
#
# Checks dependencies, then delegates to scripts/autopilot/main.sh.
#
# Usage: scripts/autopilot.sh [--dry-run]
#   --dry-run  Run triage only, print the decision, and exit (no implementation)
#
# Environment:
#   MAX_CONCURRENT  Max simultaneous implementers (default: 2)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts/autopilot"

# ─── Dependency checks ───────────────────────────────────────────────────────

check_dep() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required but not found in PATH" >&2
    echo "  $2" >&2
    exit 1
  fi
}

check_dep polytoken "Install from https://github.com/TimoFreiberg/polytoken"
check_dep jj "Install from https://github.com/jj-vcs/jj"
check_dep gh "Install from https://cli.github.com/"
check_dep jq "Install with: brew install jq"
check_dep zellij "Install with: brew install zellij"
check_dep curl "Should be pre-installed on macOS"
check_dep sed "Should be pre-installed on macOS"

# Verify gh is authenticated
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

# Verify we're in the right repo
if ! jj workspace list >/dev/null 2>&1; then
  echo "ERROR: not in a jj repository" >&2
  exit 1
fi

# Ensure the main bookmark tracks origin/main
if ! jj bookmark list main >/dev/null 2>&1; then
  echo "ERROR: no 'main' bookmark found in the repository" >&2
  exit 1
fi

echo "All dependencies present. Starting autopilot..." >&2

# ─── Delegate to main.sh ─────────────────────────────────────────────────────

exec "$SCRIPT_DIR/main.sh" "$@"
