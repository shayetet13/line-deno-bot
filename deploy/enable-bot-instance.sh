#!/usr/bin/env bash
# Registers and starts one isolated worker service.
# usage: APP_ROOT=/opt/line-first-response deploy/enable-bot-instance.sh bot-01 8791
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/line-first-response}"
BOT_ID="${1:?usage: enable-bot-instance.sh <bot-id> <loopback-port>}"
PORT="${2:?usage: enable-bot-instance.sh <bot-id> <loopback-port>}"
case "$BOT_ID" in
  *[!A-Za-z0-9_-]*|'') echo "invalid bot id: $BOT_ID" >&2; exit 2 ;;
esac
case "$PORT" in
  *[!0-9]*|'') echo "port must be an integer" >&2; exit 2 ;;
esac
(( PORT >= 1024 && PORT <= 65535 )) || { echo "port must be 1024..65535" >&2; exit 2; }

CONFIG="$APP_ROOT/config/bots/$BOT_ID.json"
[[ -f "$CONFIG" ]] || { echo "missing $CONFIG" >&2; exit 2; }
if systemctl is-active --quiet lfr-worker.service; then
  echo 'legacy lfr-worker.service is active; stop it before enabling isolated instances' >&2
  exit 2
fi
INSTANCE_DIR="$APP_ROOT/.control/instances"
mkdir -p "$INSTANCE_DIR"
if grep -Rqx "PORT=$PORT" "$INSTANCE_DIR"/*.env 2>/dev/null; then
  echo "port $PORT is already assigned" >&2
  exit 2
fi

tmp="$(mktemp "$INSTANCE_DIR/$BOT_ID.env.tmp.XXXXXX")"
printf 'PORT=%s\n' "$PORT" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$INSTANCE_DIR/$BOT_ID.env"

install -m 0644 "$APP_ROOT/current/deploy/lfr-worker@.service" /etc/systemd/system/lfr-worker@.service
systemctl daemon-reload
systemctl enable --now "lfr-worker@$BOT_ID.service"
systemctl --no-pager --full status "lfr-worker@$BOT_ID.service"
