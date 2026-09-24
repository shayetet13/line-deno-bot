#!/usr/bin/env bash
# One-time (idempotent) host setup for the reply path, run on the server after
# a release is live:
#
#   APP_ROOT=/opt/line-first-response bash deploy/enable-latency-tuning.sh
#
#  1. kernel network settings for one-shot RPCs (deploy/tune-network.sh)
#  2. hourly re-measure + pin of the fastest LINE edge address
#     (deploy/pin-legy-fast-ips.sh via legy-fast-ip-pin.timer), run once now
#  3. the current worker unit (fd limit, priority), without restarting it
#
# Undo: bash deploy/tune-network.sh --rollback; bash deploy/pin-legy-fast-ips.sh
# --rollback; systemctl disable --now legy-fast-ip-pin.timer.
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/line-first-response}"
SRC="$APP_ROOT/current/deploy"

log() { printf '\033[36m[latency]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[latency]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die 'run as root'
[[ -f "$SRC/tune-network.sh" ]] || die "missing $SRC/tune-network.sh — deploy the release first"

log 'kernel network tuning'
bash "$SRC/tune-network.sh" --apply

log 'fastest LINE edge pin: measuring now'
if ! bash "$SRC/pin-legy-fast-ips.sh" --apply; then
  log 'pin not changed this run (see output above); the timer will retry hourly'
fi
install -m 0644 "$SRC/legy-fast-ip-pin.service" /etc/systemd/system/legy-fast-ip-pin.service
install -m 0644 "$SRC/legy-fast-ip-pin.timer" /etc/systemd/system/legy-fast-ip-pin.timer

if [[ -f /etc/systemd/system/lfr-worker.service ]]; then
  install -m 0644 "$SRC/lfr-worker.service" /etc/systemd/system/lfr-worker.service
  log 'worker unit updated; it takes effect on the next restart/release'
fi
systemctl daemon-reload
systemctl enable --now legy-fast-ip-pin.timer
systemctl list-timers legy-fast-ip-pin.timer --no-pager || true
log 'done'
