#!/usr/bin/env bash
# seed-session.sh — HTTP seed a headless polytoken daemon for implementation.
#
# Waits for the daemon to become ready (polling startup.json), then performs:
#   1. Switch to plan facet (default is execute)
#   2. Enable adventurous handoff (toggle on if not already on)
#   3. Set the saved-session goal
#   4. Seed the initial prompt
#
# Usage: seed-session.sh <session_id> <port> <issue_url> <issue_title>
set -euo pipefail

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

# 4. Enable adventurous handoff (toggle only if not already on)
ENABLED=$(curl -sf -H "$AUTH" "$BASE/adventurous-handoff" | jq -r '.enabled')
if [ "$ENABLED" != "true" ]; then
  curl -sf -X POST -H "$AUTH" "$BASE/adventurous-handoff" >/dev/null
fi

# 5. Set the goal
curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg s "Implement $ISSUE_TITLE ($ISSUE_URL)" '{summary:$s}')" \
  "$BASE/goal" >/dev/null

# 6. Seed the initial prompt
PROMPT="Implement GitHub issue #$ISSUE_NUMBER: $ISSUE_TITLE

Issue URL: $ISSUE_URL
Read the issue with \`gh issue view <N> --repo TimoFreiberg/pantoken\` (use the issue number from the URL).
Follow AGENTS.md conventions.
Plan the implementation, review the plan, hand off to execute, implement,
review the implementation, and commit when done. Push is handled by the
outer script — do not push yourself.

**Commit message requirement:** your commit message MUST include
\`Fixes #$ISSUE_NUMBER\` on its own line (after the subject). This links
the commit to the GitHub issue for traceability and allows GitHub to
auto-close the issue when the commit lands on main.

Note: this workspace is a jj workspace without a .git directory, so all
\`gh\` commands MUST include \`--repo TimoFreiberg/pantoken\` explicitly.

If you discover during planning or implementation that the issue is
ambiguous and you cannot proceed without a human answer, do the following:
1. Post a comment on the GitHub issue with \`gh issue comment <N> --repo TimoFreiberg/pantoken --body \"...\"\`
   - The comment body MUST start with \`<!-- autopilot -->\` on its own line, then a blank line, then your question.
   - Ask one specific, answerable question.
2. Do NOT commit or make any code changes.
3. Stop. The outer script will handle cleanup.
This ensures the triage loop won't re-pick this issue until the human replies."

curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$PROMPT" '{content:$c}')" \
  "$BASE/prompt" >/dev/null

echo "[$(date '+%H:%M:%S')] Session $SESSION_ID seeded successfully (plan facet, adventurous handoff on)" >&2
