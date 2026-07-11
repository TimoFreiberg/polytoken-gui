#!/usr/bin/env bash
# Canonical release runtime. This file is copied into every headless artifact.
# It must remain source-checkout independent: the active version is selected only by
# resolving the pantoken-live symlink before launchd executes this wrapper.
set -euo pipefail

ROOT="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
HOME_DIR="${HOME:?HOME must be set by launchd}"
DATA_DIR="$HOME_DIR/.local/state/pantoken"
ENV_FILE="$DATA_DIR/pantoken.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "pantoken: missing runtime env file $ENV_FILE" >&2
  exit 1
fi

mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || true)"
if [[ "$mode" != "600" ]]; then
  echo "pantoken: $ENV_FILE must have mode 0600 (found $mode)" >&2
  exit 1
fi

# Parse documented unquoted KEY=VALUE records without evaluating shell syntax.
# PANTOKEN_DATA_DIR is deliberately not accepted: production state is authoritative.
seen_keys=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -n "$line" ]] || { echo "pantoken: blank env record" >&2; exit 1; }
  [[ "$line" != [[:space:]]* && "$line" != *[[:space:]] ]] || { echo "pantoken: whitespace in env record" >&2; exit 1; }
  if [[ "$line" != *=* ]]; then
    echo "pantoken: malformed env record" >&2
    exit 1
  fi
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    PANTOKEN_TOKEN|PANTOKEN_VAPID_SUBJECT|PANTOKEN_POLYTOKEN_BIN|XDG_CONFIG_HOME|XDG_DATA_HOME|PANTOKEN_LOG_LEVEL)
      ;;
    *) echo "pantoken: unsupported env key $key" >&2; exit 1 ;;
  esac
  [[ "$value" != *$'\n'* && "$value" != *'`'* && "$value" != *'$('* && "$value" != *'&&'* && "$value" != *'||'* && "$value" != *';'* && "$value" != *'|'* ]] || {
    echo "pantoken: unsafe value for $key" >&2; exit 1;
  }
  case " $seen_keys " in
    *" $key "*) echo "pantoken: duplicate env key $key" >&2; exit 1 ;;
  esac
  seen_keys+=" $key"
  case "$key" in
    PANTOKEN_POLYTOKEN_BIN|XDG_CONFIG_HOME|XDG_DATA_HOME)
      [[ "$value" == /* && "$value" != *$'\t'* && "$value" != *' '* ]] || { echo "pantoken: invalid absolute path for $key" >&2; exit 1; }
      ;;
    PANTOKEN_TOKEN)
      [[ -n "$value" && "$value" != *[[:space:]]* ]] || { echo "pantoken: invalid token" >&2; exit 1; }
      ;;
    PANTOKEN_VAPID_SUBJECT)
      [[ "$value" == https://* || "$value" == http://* || "$value" == mailto:* ]] || { echo "pantoken: invalid VAPID subject" >&2; exit 1; }
      [[ "$value" != *[[:space:]]* && "$value" != *'<'* && "$value" != *'>'* && "$value" != *'"'* && "$value" != *"'"* ]] || { echo "pantoken: invalid VAPID subject" >&2; exit 1; }
      ;;
  esac
  export "$key=$value"
done < "$ENV_FILE"

export PANTOKEN_DATA_DIR="$DATA_DIR"
export PANTOKEN_HOST="127.0.0.1"
export PANTOKEN_PORT="8787"
export PANTOKEN_CLIENT_DIST="$ROOT/client-dist"

[[ -x "$ROOT/bin/pantoken-server" ]] || { echo "pantoken: missing executable $ROOT/bin/pantoken-server" >&2; exit 1; }
[[ -f "$ROOT/client-dist/index.html" ]] || { echo "pantoken: missing client $ROOT/client-dist/index.html" >&2; exit 1; }

exec "$ROOT/bin/pantoken-server"
