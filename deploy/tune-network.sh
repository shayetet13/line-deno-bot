#!/usr/bin/env bash
# Host network tuning for the LINE reply path (Debian/Ubuntu; also the host
# side of a Docker deployment — containers on `network_mode: host` use the
# host's stack and cannot change these sysctls themselves).
#
#   sudo bash deploy/tune-network.sh --dry-run   # show what would change
#   sudo bash deploy/tune-network.sh --apply     # write + load, keep a backup
#   sudo bash deploy/tune-network.sh --rollback  # restore the previous state
#   sudo bash deploy/tune-network.sh --check     # report only (no root needed)
#
# What matters for a one-shot reply over an already-open TLS connection is
# small: the request is a few hundred bytes on a warm HTTP/2 session, so there
# is no handshake and no bulk transfer to tune. The settings below remove the
# kernel behaviours that DO add milliseconds to such a request:
#
#  - tcp_slow_start_after_idle=0  a reply after a quiet minute keeps its
#    congestion window instead of restarting slow start
#  - fq + bbr                     paced sends, no queue build-up on the NIC
#  - tcp_notsent_lowat            unsent data does not sit in the socket
#  - keepalive / retries2         a dead connection is noticed in about a
#    minute rather than fifteen, so the lane is replaced before it is needed
#  - optional busy polling (--busy-poll): the kernel spins briefly for the
#    response instead of sleeping; saves tens of microseconds per reply, costs
#    CPU — only on a host with spare cores
#
# TLS itself costs nothing per reply once the connection is up (symmetric
# crypto on a few hundred bytes, microseconds with AES-NI). What makes TLS
# expensive is a NEW connection — which is why reply lanes are opened and
# measured before replies may use them. --check reports whether this CPU
# has AES-NI and whether LINE negotiates TLS 1.3 + HTTP/2 from here.

set -euo pipefail

CONF="${LFR_SYSCTL_CONF:-/etc/sysctl.d/90-line-first-response.conf}"
BACKUP_DIR="${LFR_TUNE_BACKUP_DIR:-/var/backups/line-first-response-net}"
LINE_HOST="${LFR_LINE_HOST:-legy.line-apps.com}"
BUSY_POLL_US="${LFR_BUSY_POLL_US:-50}"

mode="${1:---check}"
busy_poll=0
for arg in "$@"; do [[ "$arg" == "--busy-poll" ]] && busy_poll=1; done
case "$mode" in
  --apply | --dry-run | --rollback | --check) ;;
  *) echo "usage: $0 [--check|--dry-run|--apply|--rollback] [--busy-poll]" >&2; exit 2 ;;
esac

log() { printf '\033[36m[tune]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[tune]\033[0m %s\n' "$*" >&2; }

desired_conf() {
  cat <<EOF
# Managed by line-first-response deploy/tune-network.sh — edit there.
# Low-latency one-shot RPCs over long-lived TLS/HTTP2 connections.
net.ipv4.tcp_slow_start_after_idle = 0
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_notsent_lowat = 16384
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6
net.ipv4.tcp_retries2 = 8
net.ipv4.tcp_fin_timeout = 15
net.ipv4.ip_local_port_range = 10240 65535
net.core.somaxconn = 4096
net.ipv4.tcp_fastopen = 1
EOF
  if [[ "$busy_poll" -eq 1 ]]; then
    printf 'net.core.busy_poll = %s\nnet.core.busy_read = %s\n' "$BUSY_POLL_US" "$BUSY_POLL_US"
  fi
}

check() {
  log "kernel $(uname -r), $(nproc) vCPU"
  for key in net.ipv4.tcp_slow_start_after_idle net.core.default_qdisc \
    net.ipv4.tcp_congestion_control net.ipv4.tcp_notsent_lowat net.core.busy_poll; do
    printf '  %-36s %s\n' "$key" "$(sysctl -n "$key" 2>/dev/null || echo '?')"
  done
  if grep -qw aes /proc/cpuinfo; then
    log 'AES-NI: yes — TLS record crypto is hardware-accelerated'
  else
    warn 'AES-NI: NOT exposed to this VM — every TLS record is encrypted in software'
  fi
  if grep -qw constant_tsc /proc/cpuinfo; then log 'TSC: constant (cheap, stable timers)'; fi
  local steal
  steal="$(awk '/^cpu /{print $9}' /proc/stat 2>/dev/null || echo 0)"
  log "CPU steal ticks since boot: ${steal} (grows fast on an oversold shared vCPU)"
  if command -v curl >/dev/null; then
    local out
    out="$(curl -sS -o /dev/null --http2 --tlsv1.3 --max-time 5 \
      -w 'http=%{http_version} tls_handshake=%{time_appconnect}s total=%{time_total}s ip=%{remote_ip}' \
      "https://${LINE_HOST}/SQ1" 2>&1 || true)"
    log "LINE ${LINE_HOST}: ${out}"
  fi
  if command -v ethtool >/dev/null; then
    local dev
    dev="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
    [[ -n "$dev" ]] && log "NIC ${dev}: $(ethtool -i "$dev" 2>/dev/null | awk '/^driver/{print $2}')"
  fi
}

if [[ "$mode" == "--check" ]]; then
  check
  exit 0
fi

if [[ "$(id -u)" -ne 0 && "$mode" != "--dry-run" ]]; then
  echo "must run as root" >&2
  exit 1
fi

if [[ "$mode" == "--rollback" ]]; then
  latest="$(ls -1t "$BACKUP_DIR"/*.conf 2>/dev/null | head -1 || true)"
  if [[ -z "$latest" ]]; then
    rm -f -- "$CONF"
    log "no backup: removed $CONF (kernel defaults apply after reboot or sysctl --system)"
  elif [[ "$(basename "$latest")" == *.absent.conf ]]; then
    rm -f -- "$CONF"
    log "restored: $CONF did not exist before tuning"
  else
    cp -- "$latest" "$CONF"
    log "restored $CONF from $latest"
  fi
  sysctl --system >/dev/null
  exit 0
fi

new="$(desired_conf)"
if [[ "$mode" == "--dry-run" ]]; then
  echo "--- would write $CONF ---"
  printf '%s\n' "$new"
  exit 0
fi

if ! modprobe tcp_bbr 2>/dev/null && ! grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control; then
  warn 'bbr is not available on this kernel; keeping the current congestion control'
  new="$(printf '%s\n' "$new" | grep -v tcp_congestion_control)"
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f "$CONF" ]]; then
  if [[ "$(cat "$CONF")" == "$new" ]]; then
    log "$CONF already current"
    sysctl -p "$CONF" >/dev/null
    exit 0
  fi
  cp -- "$CONF" "$BACKUP_DIR/$stamp.conf"
else
  : >"$BACKUP_DIR/$stamp.absent.conf"
fi
tmp="$(mktemp "${CONF}.XXXXXX")"
printf '%s\n' "$new" >"$tmp"
chmod 0644 "$tmp"
mv -- "$tmp" "$CONF"
if ! sysctl -p "$CONF" >/dev/null; then
  warn 'loading failed; rolling back'
  bash "$0" --rollback
  exit 1
fi
log "applied $CONF (backup in $BACKUP_DIR). Existing connections keep their old"
log 'congestion control until they reconnect; restart the worker to apply everywhere.'
check
