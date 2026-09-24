#!/usr/bin/env bash
# Switches the public service from one fixed bot to the shared multi-user
# console. Run only after the release containing the multi-user unit is live:
#   APP_ROOT=/opt/line-first-response bash deploy/enable-multi-user.sh
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/line-first-response}"
SERVICE="${SERVICE:-lfr-worker.service}"
UNIT_PATH="/etc/systemd/system/$SERVICE"
SOURCE_UNIT="$APP_ROOT/current/deploy/lfr-worker.service"
CONSOLE_URL="${CONSOLE_URL:-http://127.0.0.1:8791/account/login}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-60}"

log() { printf '\033[36m[multi-user]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[multi-user]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die 'run as root'
command -v systemctl >/dev/null || die 'systemd is required'
command -v curl >/dev/null || die 'curl is required'
[[ -f "$SOURCE_UNIT" ]] || die "missing release unit: $SOURCE_UNIT"
grep -Fq -- '--multi-bot' "$SOURCE_UNIT" || die 'release unit does not enable --multi-bot'

if systemctl list-units --type=service --state=active --no-legend 'lfr-worker@*.service' | grep -q .; then
  die 'isolated lfr-worker@ instances are active; stop the old topology before switching'
fi

backup=""
if [[ -f "$UNIT_PATH" ]]; then
  backup="${UNIT_PATH}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "$UNIT_PATH" "$backup"
  log "saved previous unit to $backup"
fi

restore() {
  [[ -n "$backup" && -f "$backup" ]] || return 0
  log 'new service did not become reachable; restoring previous unit'
  install -m 0644 "$backup" "$UNIT_PATH"
  systemctl daemon-reload
  systemctl restart "$SERVICE" || true
}

install -m 0644 "$SOURCE_UNIT" "$UNIT_PATH"
systemctl daemon-reload
if ! systemctl restart "$SERVICE"; then
  systemctl --no-pager --full status "$SERVICE" || true
  journalctl --no-pager -u "$SERVICE" -n 40 || true
  restore
  die 'could not restart multi-user service'
fi

deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while (( SECONDS < deadline )); do
  if systemctl is-active --quiet "$SERVICE" && curl -fsS --max-time 5 "$CONSOLE_URL" >/dev/null; then
    log 'multi-user service is active and the account-login page is reachable'
    systemctl --no-pager --full status "$SERVICE"
    exit 0
  fi
  sleep 2
done

restore
die "service did not become reachable at $CONSOLE_URL within ${HEALTH_TIMEOUT_S}s"
