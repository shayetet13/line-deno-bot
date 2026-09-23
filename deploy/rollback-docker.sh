#!/usr/bin/env bash
# Roll this VPS back from Docker (backend + front-local nginx) to the
# systemd `lfr-worker` + `nginx` services they replaced. Run this ON the
# VPS itself, from the directory holding docker-compose.yml.
#
# Safe either direction: the container and the systemd unit read/write the
# exact same config/, .sessions/ and .control/ directories in place — this
# only swaps which process serves them, it never touches the data. The
# runbook's `chown -R 1000:1000` on those directories (done before the
# Docker container's first start) does NOT need to be undone here: the
# systemd unit runs as root, and root can read/write files owned by any uid.
# The runbook never deletes either unit file, only `disable`s them, so
# `enable` + `restart` here always has something to start. Note: the old
# systemd nginx (deploy/nginx-dashboard.conf) was plain HTTP on :80, not
# TLS — this rollback restores that, it does not carry the front
# container's self-signed cert back to it.
#
# Usage: sudo bash rollback-docker.sh
set -euo pipefail

SERVICE="lfr-worker"
FRONT_SERVICE="nginx"
PORT=8791   # hardcoded in the unit's ExecStart (deploy/lfr-worker.service), not env-driven
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

[[ $EUID -eq 0 ]] || { log_error "run as root (systemctl + docker need it)"; exit 1; }

log_info "=== vps3: Docker -> systemd rollback ==="
log_info "Compose dir: $COMPOSE_DIR"
log_info "Target services: $SERVICE, $FRONT_SERVICE"

if ! docker compose -f "$COMPOSE_DIR/docker-compose.yml" ps --status running -q 2>/dev/null | grep -q .; then
	log_warn "Docker containers are not currently running — proceeding anyway (systemd may already be live)."
fi

read -r -p "Stop Docker (backend + front) and start systemd $SERVICE + $FRONT_SERVICE instead? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || { log_error "Aborted"; exit 1; }

log_info "==> Step 1: Stop the Docker containers"
( cd "$COMPOSE_DIR" && docker compose down )

log_info "==> Step 2: Re-enable and start $SERVICE and $FRONT_SERVICE"
systemctl enable "$SERVICE" "$FRONT_SERVICE"
systemctl restart "$SERVICE" "$FRONT_SERVICE"

sleep 4
for svc in "$SERVICE" "$FRONT_SERVICE"; do
	STATE="$(systemctl is-active "$svc" || true)"
	log_info "    $svc: $STATE"
	if [ "$STATE" != "active" ]; then
		log_error "$svc did not come up. Check: journalctl -u $svc -n 100 --no-pager"
		exit 1
	fi
done

log_info "==> Step 3: Health check"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo 000)"
if [ "$CODE" = "200" ] || [ "$CODE" = "401" ] || [ "$CODE" = "503" ]; then
	log_info "backend /api/health -> HTTP $CODE (worker reachable; 503 = up but a bot isn't LINE-connected yet, not a rollback failure)"
else
	log_warn "backend /api/health -> HTTP $CODE (check journalctl if this doesn't recover in a few seconds)"
fi
FRONT_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1/" 2>/dev/null || echo 000)"
log_info "nginx http://127.0.0.1/ -> HTTP $FRONT_CODE (plain HTTP — old config had no TLS)"

log_info "=== Rollback complete: systemd $SERVICE + $FRONT_SERVICE are live, Docker stopped ==="
log_warn "Config/session/user data untouched — this only reverted which process serves them."
