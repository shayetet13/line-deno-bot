#!/usr/bin/env bash
# Keep the actual Square RPC endpoint on the fast side of its current address
# pool. In LINEJS's default auto mode, Square /SQ1 goes directly to legy;
# selected Talk routes use gf /enc instead. Both names are pinned so push,
# poll, and send cannot resolve onto a known-slow edge.
# Resolution is obtained through DoH so an existing /etc/hosts pin cannot hide
# pool changes. Every candidate is measured with real HTTPS requests (TLS and
# SNI intact), not ICMP. Applying is transactional and verification rolls back.
#
# Ranking uses the WARM request time: several requests over ONE HTTP/2
# connection per address, first one discarded. A reply always travels over an
# already-open lane, so the handshake is not what it pays — the per-request
# time on an open connection is. The handshake is still printed for reference.
#
# The OS resolver prefers IPv6 over IPv4 regardless of file order, so when the
# fastest address is IPv4 only IPv4 addresses are pinned (and vice versa for
# IPv6 first); the order getaddrinfo will actually return is then verified.

set -euo pipefail

TARGET_HOST="${LEGY_PIN_TARGET_HOST:-legy.line-apps.com}"
INNER_HOST="${LEGY_PIN_INNER_HOST:-gf.line.naver.jp}"
PROBE_PATH="${LEGY_PIN_PROBE_PATH:-/SQ1}"
HOSTS_FILE="${LEGY_PIN_HOSTS_FILE:-/etc/hosts}"
BACKUP_DIR="${LEGY_PIN_BACKUP_DIR:-/var/backups/legy-hosts-pin}"
BEGIN_MARKER="# BEGIN legy-fast-ip-pin (managed by line-first-response)"
END_MARKER="# END legy-fast-ip-pin"
SAMPLES="${LEGY_PIN_SAMPLES:-8}"
# Requests per connection; the first carries the handshake and is not ranked.
WARM_REQUESTS="${LEGY_PIN_WARM_REQUESTS:-6}"
TIMEOUT="${LEGY_PIN_TIMEOUT:-5}"
SLOW_MULTIPLIER="${LEGY_PIN_SLOW_MULTIPLIER:-1.8}"
ABSOLUTE_CEILING_MS="${LEGY_PIN_ABSOLUTE_CEILING_MS:-25}"
MIN_FAST_IPS="${LEGY_PIN_MIN_FAST_IPS:-4}"
DOH_RESOLVER="${LEGY_PIN_DOH_RESOLVER:-https://cloudflare-dns.com/dns-query}"
FORCE_EXCLUDE_RAW="${LEGY_PIN_FORCE_EXCLUDE_IPS:-147.92.249.185 2400:dcc0:a303:b1a4::39}"
read -r -a FORCE_EXCLUDE <<< "${FORCE_EXCLUDE_RAW//,/ }"
PIN_HOSTS=("$TARGET_HOST")
if [[ "$INNER_HOST" != "$TARGET_HOST" ]]; then
  PIN_HOSTS+=("$INNER_HOST")
fi
PIN_HOSTS_TEXT="${PIN_HOSTS[*]}"

mode="${1:---apply}"
case "$mode" in
  --apply | --dry-run | --rollback) ;;
  *) echo "usage: $0 [--apply|--dry-run|--rollback]" >&2; exit 2 ;;
esac

if [[ "$mode" != "--dry-run" && "$(id -u)" -ne 0 ]]; then
  echo "must run as root to change $HOSTS_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

if [[ "$mode" == "--rollback" ]]; then
  latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'hosts.*.bak' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
  [[ -n "$latest" ]] || { echo "no backup in $BACKUP_DIR" >&2; exit 1; }
  cp -- "$latest" "$HOSTS_FILE"
  echo "rolled back $HOSTS_FILE from $latest"
  exit 0
fi

command -v curl >/dev/null || { echo "curl is required" >&2; exit 127; }

resolve_pool() {
  local qtype="$1" type_number="$2"
  curl -fsS --max-time "$TIMEOUT" -H 'accept: application/dns-json' \
    "${DOH_RESOLVER}?name=${TARGET_HOST}&type=${qtype}" |
    grep -oE '"type":'"${type_number}"',"TTL":[0-9]+,"data":"[^"]+"' |
    grep -oE '"data":"[^"]+"' | cut -d'"' -f4
}

mapfile -t pool < <({ resolve_pool A 1; resolve_pool AAAA 28; } | sort -u)
if [[ "${#pool[@]}" -eq 0 ]]; then
  echo "DoH returned no addresses; leaving $HOSTS_FILE unchanged" >&2
  exit 1
fi
echo "resolved ${#pool[@]} addresses"

median_of() {
  sort -n | awk '{v[NR]=$1} END {if (NR == 0) exit 1; print NR%2 ? v[(NR+1)/2] : (v[NR/2]+v[NR/2+1])/2}'
}

# One curl = one TCP/TLS/H2 connection carrying WARM_REQUESTS requests. Prints
# "handshake_ms warm_ms warm_ms ..." (warm = every request after the first).
probe_connection() {
  local ip="$1" targets=() i
  # Each URL needs its own `-o`, or every body after the first lands on stdout.
  for ((i = 0; i < WARM_REQUESTS; i++)); do
    targets+=(-o /dev/null "https://${TARGET_HOST}${PROBE_PATH}")
  done
  # HTTP status is irrelevant: unauthenticated /SQ1 returns a 4xx, which still
  # crosses the exact TCP/TLS/H2 route LINE uses for Square RPCs.
  curl --http2 --resolve "${TARGET_HOST}:443:${ip}" -sS --max-time "$TIMEOUT" \
    -w '%{time_appconnect} %{time_total} %{time_pretransfer}\n' \
    "${targets[@]}" 2>/dev/null |
    awk 'NR == 1 { printf "%.3f", $1 * 1000; next }
         { printf " %.3f", ($2 - $3) * 1000 } END { print "" }' || true
}

declare -A median_by_ip
all_medians=()
for ip in "${pool[@]}"; do
  warm=()
  handshakes=()
  for ((sample = 0; sample < SAMPLES; sample++)); do
    read -r -a fields <<<"$(probe_connection "$ip")"
    [[ "${#fields[@]}" -ge 2 ]] || continue
    handshakes+=("${fields[0]}")
    warm+=("${fields[@]:1}")
  done
  if [[ "${#warm[@]}" -eq 0 ]]; then
    median_by_ip["$ip"]="999999"
    printf '  %-28s unreachable\n' "$ip"
    continue
  fi
  median="$(printf '%s\n' "${warm[@]}" | median_of)"
  handshake="$(printf '%s\n' "${handshakes[@]}" | median_of)"
  median_by_ip["$ip"]="$median"
  all_medians+=("$median")
  printf '  %-28s warm_median=%sms (n=%d)  tls_handshake=%sms\n' \
    "$ip" "$median" "${#warm[@]}" "$handshake"
done

[[ "${#all_medians[@]}" -gt 0 ]] || {
  echo "no address completed HTTPS; leaving $HOSTS_FILE unchanged" >&2
  exit 1
}
overall="$(printf '%s\n' "${all_medians[@]}" | sort -n | awk \
  '{v[NR]=$1} END {print NR%2 ? v[(NR+1)/2] : (v[NR/2]+v[NR/2+1])/2}')"
if awk -v value="$overall" -v ceiling="$ABSOLUTE_CEILING_MS" \
  'BEGIN { exit !(value > ceiling) }'; then
  echo "pool median ${overall}ms exceeds ${ABSOLUTE_CEILING_MS}ms; refusing a likely wrong-region pin" >&2
  exit 1
fi
threshold="$(awk -v value="$overall" -v factor="$SLOW_MULTIPLIER" \
  'BEGIN { printf "%.3f", value * factor }')"

fast=()
slow=()
for ip in "${pool[@]}"; do
  excluded=0
  for blocked in "${FORCE_EXCLUDE[@]}"; do
    [[ "$ip" == "$blocked" ]] && excluded=1 && break
  done
  if [[ "$excluded" -eq 0 ]] && awk -v value="${median_by_ip[$ip]}" -v limit="$threshold" \
    'BEGIN { exit !(value <= limit) }'; then
    fast+=("$ip")
  else
    slow+=("$ip")
  fi
done
if [[ "${#fast[@]}" -gt 0 ]]; then
  mapfile -t fast < <(
    for ip in "${fast[@]}"; do printf '%s\t%s\n' "${median_by_ip[$ip]}" "$ip"; done |
      sort -n | cut -f2-
  )
  # getaddrinfo puts IPv6 before IPv4 whatever the file order says. Keep the
  # family of the fastest address so the first address the worker connects to
  # really is the fastest one; the other family is only a fallback in DNS.
  best_family=4
  [[ "${fast[0]}" == *:* ]] && best_family=6
  mapfile -t fast < <(
    for ip in "${fast[@]}"; do
      if [[ "$best_family" == 6 ]] || [[ "$ip" != *:* ]]; then printf '%s\n' "$ip"; fi
    done
  )
fi

echo "pool median=${overall}ms threshold=${threshold}ms"
echo "fast (${#fast[@]}): ${fast[*]:-none}"
echo "excluded (${#slow[@]}): ${slow[*]:-none}"
if [[ "${#fast[@]}" -lt "$MIN_FAST_IPS" ]]; then
  echo "only ${#fast[@]} fast addresses; need at least $MIN_FAST_IPS, leaving hosts unchanged" >&2
  exit 1
fi

new_block="$BEGIN_MARKER
# Measured HTTPS $(date -u +%FT%TZ); fastest median first; each connection keeps its own SNI."
for ip in "${fast[@]}"; do new_block+=$'\n'"$ip $PIN_HOSTS_TEXT"; done
new_block+=$'\n'"$END_MARKER"

if [[ "$mode" == "--dry-run" ]]; then
  echo "--- proposed hosts block ---"
  printf '%s\n' "$new_block"
  exit 0
fi

current_ips="$(awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" \
  '$0==begin {inside=1; next} $0==end {exit} inside && $1 !~ /^#/ {$1=$1; print}' \
  "$HOSTS_FILE" | sort -u || true)"
desired_ips="$(for ip in "${fast[@]}"; do printf '%s %s\n' "$ip" "$PIN_HOSTS_TEXT"; done | sort -u)"
if [[ "$current_ips" == "$desired_ips" ]]; then
  echo "$HOSTS_FILE already contains the current fast set; preserving its stable order"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$BACKUP_DIR/hosts.${stamp}.bak"
cp -- "$HOSTS_FILE" "$backup"
tmp="$(mktemp "${HOSTS_FILE}.legy.XXXXXX")"
trap 'rm -f -- "${tmp:-}"' EXIT

if grep -qF "$BEGIN_MARKER" "$HOSTS_FILE"; then
  awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" -v block="$new_block" '
    $0==begin {print block; inside=1; next}
    $0==end {inside=0; next}
    !inside {print}
  ' "$HOSTS_FILE" >"$tmp"
else
  cp -- "$HOSTS_FILE" "$tmp"
  printf '\n%s\n' "$new_block" >>"$tmp"
fi
# Rewrite in place, keeping the inode: a Docker container that bind-mounts
# /etc/hosts holds the original inode, so a rename would leave it reading the
# old pin forever. The content is a few hundred bytes; a reader racing this
# write can only ever fall back to DNS for one lookup.
cat -- "$tmp" >"$HOSTS_FILE"
rm -f -- "$tmp"
trap - EXIT

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
  "https://${TARGET_HOST}${PROBE_PATH}" 2>/dev/null || true)"
if [[ -z "$code" || "$code" == "000" ]]; then
  cp -- "$backup" "$HOSTS_FILE"
  echo "HTTPS verification failed; restored $backup" >&2
  exit 1
fi

echo "updated $HOSTS_FILE; HTTPS verification returned HTTP $code"
if command -v getent >/dev/null; then
  first="$(getent ahosts "$TARGET_HOST" | awk 'NR == 1 {print $1}')"
  if [[ "$first" == "${fast[0]}" ]]; then
    echo "resolver order verified: new connections go to ${first} first"
  else
    echo "warning: the resolver returns ${first:-nothing} first, not ${fast[0]} — check /etc/gai.conf" >&2
  fi
fi
echo "no restart needed: reply lanes pick the new address up as the scout re-rolls them,"
echo "and every lane does on its next reconnect; restart the worker to move all at once"
