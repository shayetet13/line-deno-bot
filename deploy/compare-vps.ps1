[CmdletBinding()]
param(
    [string]$Vps1Host = '172.237.8.10',

    [string]$Vps3Host = '172.237.2.229',

    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')]
    [string]$User = 'root',

    [string]$IdentityFile
)

# Collects read-only host, service, release and network-route diagnostics from
# both VPSes. It deliberately does not read LINE session files, user files,
# bot configuration, environment files, or logs that could contain secrets.
#
# Use the default SSH config/key selection:
#   .\deploy\compare-vps.ps1
# Or nominate a particular key without exposing its content:
#   .\deploy\compare-vps.ps1 -IdentityFile "$HOME\.ssh\id_ed25519"

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Fail 'OpenSSH client (ssh.exe) was not found.'
}

if ($IdentityFile) {
    $IdentityFile = [Environment]::ExpandEnvironmentVariables($IdentityFile)
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        Fail "SSH identity file was not found: $IdentityFile"
    }
    $IdentityFile = (Resolve-Path -LiteralPath $IdentityFile).Path
}

$probe = @'
set -u
APP_ROOT=/opt/line-first-response
SERVICE=lfr-worker.service

section() { printf '\n=== %s ===\n' "$1"; }

section identity
hostnamectl --static 2>/dev/null || hostname
uname -srmo
date -u +%Y-%m-%dT%H:%M:%SZ

section capacity
printf 'cpu='; nproc 2>/dev/null || true
free -m 2>/dev/null || true
df -h / 2>/dev/null || true
uptime 2>/dev/null || true

section release
printf 'current='; readlink -f "$APP_ROOT/current" 2>/dev/null || true
if [ -f "$APP_ROOT/current/.release.json" ]; then
  cat "$APP_ROOT/current/.release.json"
fi

section service
SYSTEMD_PAGER=cat systemctl --no-pager is-active "$SERVICE" 2>&1 || true
SYSTEMD_PAGER=cat systemctl --no-pager show "$SERVICE" \
  -p ExecStart -p MainPID -p ActiveEnterTimestamp -p MemoryCurrent -p CPUUsageNSec --value 2>&1 || true
pid="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || true)"
case "$pid" in
  ''|0|*[!0-9]*) ;;
  *) ps -o pid,etimes,%cpu,%mem,rss,vsz,cmd -p "$pid" 2>/dev/null || true ;;
esac

section local-http
curl -sS --max-time 5 -o /dev/null -w 'health status=%{http_code} connect=%{time_connect}s total=%{time_total}s\n' http://127.0.0.1:8791/api/health || true
curl -sS --max-time 5 -o /dev/null -D - http://127.0.0.1:8791/app | sed -n '1,12p' || true

section line-route
printf 'curl='; curl --version 2>/dev/null | sed -n '1p' || true
printf 'ipv4='; getent ahostsv4 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' '; printf '\n'
printf 'ipv6='; getent ahostsv6 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' '; printf '\n'
for family in -4 -6; do
  printf 'family=%s\n' "$family"
  for n in 1 2 3; do
    curl "$family" -sS --connect-timeout 5 --max-time 12 -o /dev/null \
      -w "legy sample=${n} status=%{http_code} remote=%{remote_ip} connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s\n" \
      https://legy.line-apps.com/ || true
  done
done

section line-addresses
for family in 4 6; do
  if [ "$family" = 4 ]; then
    addresses="$(getent ahostsv4 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u)"
  else
    addresses="$(getent ahostsv6 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u)"
  fi
  for address in $addresses; do
    for n in 1 2; do
      curl "-$family" -sS --connect-timeout 5 --max-time 12 --resolve "legy.line-apps.com:443:$address" -o /dev/null \
        -w "pinned family=${family} address=${address} sample=${n} status=%{http_code} remote=%{remote_ip} connect=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s\n" \
        https://legy.line-apps.com/ || true
    done
  done
done

section routes
for address in $(getent ahostsv4 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u); do
  printf 'route4 address=%s ' "$address"
  ip route get "$address" 2>/dev/null || true
done
for address in $(getent ahostsv6 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u); do
  printf 'route6 address=%s ' "$address"
  ip -6 route get "$address" 2>/dev/null || true
done

section trace
for command in tracepath traceroute; do
  if command -v "$command" >/dev/null 2>&1; then
    printf 'tool=%s\n' "$command"
    for address in $(getent ahostsv4 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u | head -n 1); do
      timeout 8s "$command" -4 -n -m 12 "$address" 2>&1 | sed -n '1,14p' || true
    done
    for address in $(getent ahostsv6 legy.line-apps.com 2>/dev/null | awk '{print $1}' | sort -u | head -n 1); do
      timeout 8s "$command" -6 -n -m 12 "$address" 2>&1 | sed -n '1,14p' || true
    done
    break
  fi
done

section sockets
ss -s 2>/dev/null || true
'@

function Invoke-Probe([string]$Label, [string]$Target) {
    $sshArguments = @('-o', 'BatchMode=no', '-o', 'ConnectTimeout=10')
    if ($IdentityFile) {
        $sshArguments += @('-i', $IdentityFile)
    }
    Write-Host "`n######## $Label ($Target) ########" -ForegroundColor Cyan
    $probe | & ssh @sshArguments "$User@$Target" 'bash -s'
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "$Label SSH command exited with code $LASTEXITCODE"
    }
}

Invoke-Probe 'VPS1' $Vps1Host
Invoke-Probe 'VPS3' $Vps3Host
