#!/usr/bin/env bash
# One systemd instance owns one LINE bot.  Do not add --multi-bot here.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/line-first-response}"
BOT_ID="${1:?usage: run-bot-instance.sh <bot-id>}"
case "$BOT_ID" in
  *[!A-Za-z0-9_-]*|'') echo "invalid bot id: $BOT_ID" >&2; exit 2 ;;
esac

INSTANCE_FILE="$APP_ROOT/.control/instances/$BOT_ID.env"
CONFIG="$APP_ROOT/config/bots/$BOT_ID.json"
USERS_FILE="$APP_ROOT/.control/bot-users/$BOT_ID.json"
[[ -f "$INSTANCE_FILE" ]] || { echo "missing $INSTANCE_FILE" >&2; exit 2; }
[[ -f "$CONFIG" ]] || { echo "missing $CONFIG" >&2; exit 2; }

# The file is root-owned deployment metadata, never user-provided input.
# shellcheck disable=SC1090
source "$INSTANCE_FILE"
case "${PORT:-}" in
  ''|*[!0-9]*) echo "PORT must be an integer in $INSTANCE_FILE" >&2; exit 2 ;;
esac
(( PORT >= 1 && PORT <= 65535 )) || { echo "PORT out of range in $INSTANCE_FILE" >&2; exit 2; }

mkdir -p "$(dirname "$USERS_FILE")"
cd "$APP_ROOT/current"
exec /root/.deno/bin/deno task serve \
  --config "$CONFIG" \
  --sessions-dir "$APP_ROOT/.sessions" \
  --users-file "$USERS_FILE" \
  --port "$PORT"
