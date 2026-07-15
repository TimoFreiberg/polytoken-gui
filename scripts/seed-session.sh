#!/usr/bin/env bash
# seed-session.sh — HTTP seed a headless polytoken daemon for implementation.
#
# Waits for the daemon to become ready (polling startup.json), then performs:
#   1. Switch to plan facet (default is execute)
#   2. Set permission mode to bypass_plus
#   3. Enable adventurous handoff (toggle on if not already on)
#   4. Set the saved-session goal
#   5. Seed the initial prompt (from seed-prompt.md template)
#
# Usage: seed-session.sh <session_id> <port> <issue_url> <issue_title>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SESSION_ID="${1:?usage: seed-session.sh <session_id> <port> <issue_url> <issue_title>}"
PORT="${2:?port required}"
ISSUE_URL="${3:?issue_url required}"
ISSUE_TITLE="${4:?issue_title required}"
# Extract issue number from URL (e.g. .../issues/21 → 21)
ISSUE_NUMBER="${ISSUE_URL##*/}"

SESSION_DIR="$HOME/.local/share/polytoken/sessions/$SESSION_ID"
STARTUP="$SESSION_DIR/startup.json"

# 1. Wait for daemon readiness (poll startup.json state, 15s timeout)
STATE=""
for _ in $(seq 1 30); do
  STATE=$(jq -r '.state // empty' "$STARTUP" 2>/dev/null || true)
  [ "$STATE" = "ready" ] && break
  sleep 0.5
done
if [ "$STATE" != "ready" ]; then
  echo "[$(date '+%H:%M:%S')] ERROR: daemon not ready after 15s (session: $SESSION_ID)" >&2
  exit 1
fi

# 2. Read credential path from startup.json (not hardcoded)
CRED_PATH=$(jq -r '.credential_file_path' "$STARTUP")
TOKEN=$(jq -r '.token' "$CRED_PATH")
AUTH="Authorization: Bearer $TOKEN"
BASE="http://localhost:$PORT"

# 3. Switch to plan facet (default is execute)
curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"facet":"plan"}' "$BASE/facet" >/dev/null

# 4. Set permission mode to bypass_plus
curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"mode":"bypass_plus"}' \
  "$BASE/permission-monitor" >/dev/null

# 5. Enable adventurous handoff (toggle only if not already on)
ENABLED=$(curl -sf -H "$AUTH" "$BASE/adventurous-handoff" | jq -r '.enabled')
if [ "$ENABLED" != "true" ]; then
  curl -sf -X POST -H "$AUTH" "$BASE/adventurous-handoff" >/dev/null
fi

# 6. Set the goal
curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg s "Implement $ISSUE_TITLE ($ISSUE_URL)" '{summary:$s}')" \
  "$BASE/goal" >/dev/null

# 7. Seed the initial prompt (from template, with placeholders substituted)
PROMPT=$(ISSUE_NUMBER="$ISSUE_NUMBER" ISSUE_URL="$ISSUE_URL" ISSUE_TITLE="$ISSUE_TITLE" \
  awk '
    $0 == "{{ISSUE_NUMBER}}" { print ENVIRON["ISSUE_NUMBER"]; next }
    $0 == "{{ISSUE_URL}}" { print ENVIRON["ISSUE_URL"]; next }
    $0 == "{{ISSUE_TITLE}}" { print ENVIRON["ISSUE_TITLE"]; next }
    { print }
  ' "$SCRIPT_DIR/seed-prompt.md")

curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$PROMPT" '{content:$c}')" \
  "$BASE/prompt" >/dev/null

echo "[$(date '+%H:%M:%S')] Session $SESSION_ID seeded successfully (plan facet, bypass_plus, adventurous handoff on)" >&2
