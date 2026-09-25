#!/usr/bin/env bash
# Server side of deploy/deploy-docker.ps1. Builds one commit into an image,
# swaps the running container, health-checks it, and rolls back on failure.
#
#   bash release.sh <archive.tar> <commit>   deploy that commit
#   bash release.sh --status                  what is live
#   bash release.sh --rollback                back to the previous release
#
# Environment:
#   LFR_PORT     console port (8793)
#   LFR_ROOT     releases and bookkeeping (/opt/lfr-$LFR_PORT)
#   LFR_DATA     config/, .sessions/, .control/, .env — the state that must
#                survive (default: LFR_ROOT). Point it at an existing
#                installation to take over its accounts, LINE sessions and
#                rules unchanged. Remembered for later runs.
#   LFR_REPLACE  containers this release takes over from (comma or space
#                separated), e.g. "linebot-vps3-front,linebot-vps3". They are
#                stopped — never removed — only after the new image is built,
#                started again if the new release does not come up, and are
#                what --rollback returns to when there is no earlier release.
#   KEEP_RELEASES (5), HEALTH_TIMEOUT_S (120), LFR_SLOT_BUDGET (1 — polled
#   rooms per bot for a brand-new install; docs/runbook.md §10).
set -Eeuo pipefail

PORT="${LFR_PORT:-8793}"
ROOT="${LFR_ROOT:-/opt/lfr-$PORT}"
DATA="${LFR_DATA:-$(cat "$ROOT/data-root" 2>/dev/null || printf '%s' "$ROOT")}"
KEEP="${KEEP_RELEASES:-5}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
IMAGE=line-first-response
NAME="lfr-$PORT"
REPLACE_LIST="${LFR_REPLACE:-}"
read -r -a REPLACE <<<"${REPLACE_LIST//,/ }"

log() { printf '\033[36m[docker-release]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[docker-release]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[docker-release]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die 'run as root'
command -v docker >/dev/null || die 'docker is not installed'
docker compose version >/dev/null 2>&1 || die 'docker compose v2 is required'
[[ "$PORT" =~ ^[0-9]+$ ]] || die "LFR_PORT must be a number, got $PORT"
for name in "${REPLACE[@]}"; do
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "not a container name: $name"
done

# Run as whoever owns the existing state, so taking over an installation
# never changes the ownership of its files (and the old one can come back).
if [[ -n "${LFR_UID:-}" ]]; then
  UID_GID="${LFR_UID}:${LFR_GID:-$LFR_UID}"
elif [[ -d "$DATA/.control" ]]; then
  UID_GID="$(stat -c '%u:%g' "$DATA/.control")"
else
  UID_GID=1000:1000
fi

compose() {
  local release="$1" tag="$2"
  shift 2
  LFR_DATA="$DATA" LFR_PORT="$PORT" IMAGE_TAG="$tag" \
    LFR_UID="${UID_GID%%:*}" LFR_GID="${UID_GID##*:}" \
    docker compose -f "$release/deploy/docker/compose.yml" "$@"
}

# Healthy = OUR container is running without having restarted, and the port
# answers the login page. The port alone is not enough: anything else still
# listening there would answer too, and a container that cannot bind the port
# exits and restarts rather than failing loudly.
healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) code state
  while ((SECONDS < deadline)); do
    state="$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$NAME" 2>/dev/null || true)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:$PORT/account/login" || true)"
    [[ "$state" == "true 0" && "$code" == 200 ]] && return 0
    sleep 2
  done
  return 1
}

# Anything LISTENing on the port, on any address. /proc is the fallback for
# hosts without iproute2's `ss`.
port_busy() {
  if command -v ss >/dev/null; then
    ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN
    return
  fi
  # Only tables that exist: a host without IPv6 has no tcp6, and awk failing
  # on a missing file must not read as "port free".
  local tables=()
  for table in /proc/net/tcp /proc/net/tcp6; do [[ -r "$table" ]] && tables+=("$table"); done
  ((${#tables[@]} > 0)) || return 1
  awk -v port="$(printf '%04X' "$PORT")" '
    $4 == "0A" { n = split($2, a, ":"); if (toupper(a[n]) == port) found = 1 }
    END { exit !found }' "${tables[@]}"
}
port_holder() {
  if command -v ss >/dev/null; then ss -ltnp "sport = :$PORT" | tail -1; else echo "(see: docker ps)"; fi
}
current_tag() { cat "$ROOT/current-tag" 2>/dev/null || true; }
previous_tag() { cat "$ROOT/previous-tag" 2>/dev/null || true; }
replaced() { cat "$ROOT/replaced-containers" 2>/dev/null || true; }

status() {
  local live prev old
  live="$(current_tag)"
  prev="$(previous_tag)"
  old="$(replaced)"
  printf 'root:     %s\n' "$ROOT"
  printf 'data:     %s\n' "$DATA"
  printf 'live:     %s\n' "${live:-none}"
  printf 'previous: %s\n' "${prev:-none}"
  docker ps -a --filter "name=^${NAME}$" --format 'container: {{.Names}} {{.Status}} {{.Image}}' || true
  if [[ -n "$old" ]]; then
    printf 'replaced: %s\n' "$old"
    for name in $old; do
      docker ps -a --filter "name=^${name}$" --format '  {{.Names}} {{.Status}}' || true
    done
  fi
  curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health" || true
  echo
}

switch_to() {
  local tag="$1"
  compose "$ROOT/releases/$tag" "$tag" up -d --force-recreate --remove-orphans
}

# Stops the containers being taken over and waits for the port to free up.
stop_replaced() {
  ((${#REPLACE[@]} > 0)) || return 0
  log "stopping ${REPLACE[*]} (stopped, not removed)"
  docker stop -t 30 "${REPLACE[@]}" >/dev/null
  printf '%s\n' "${REPLACE[*]}" >"$ROOT/replaced-containers"
  local deadline=$((SECONDS + 15))
  while port_busy && ((SECONDS < deadline)); do sleep 1; done
  if port_busy; then
    start_replaced
    die "port $PORT is still in use after stopping ${REPLACE[*]}: $(port_holder)"
  fi
}

start_replaced() {
  local old
  old="$(replaced)"
  [[ -n "$old" ]] || return 0
  warn "starting the replaced containers again: $old"
  # shellcheck disable=SC2086
  docker start $old >/dev/null
}

rollback() {
  local prev
  prev="$(previous_tag)"
  if [[ -n "$prev" && -d "$ROOT/releases/$prev" ]]; then
    log "rolling back to $prev"
    switch_to "$prev" && healthy ||
      die "previous release $prev is not healthy either — see: docker logs $NAME"
    printf '%s\n' "$(current_tag)" >"$ROOT/previous-tag"
    printf '%s\n' "$prev" >"$ROOT/current-tag"
    ln -sfn "$ROOT/releases/$prev" "$ROOT/current"
    log "rolled back; live is $prev"
    return 0
  fi
  [[ -n "$(replaced)" ]] || die 'no previous release to roll back to'
  log "no earlier release of $NAME — handing port $PORT back to: $(replaced)"
  docker stop -t 30 "$NAME" >/dev/null 2>&1 || true
  start_replaced
  rm -f -- "$ROOT/current-tag"
  log "rolled back to the replaced containers; $NAME is stopped (data untouched)"
}

# A brand-new install gets a config that answers nothing and posts nothing
# (dryRun) until its owner picks rooms. Its admin password is generated by the
# app itself on first start (see show_first_password). An existing
# installation's files are used exactly as they are.
first_install() {
  local release="$1" config="$DATA/config/bots/bot-1.json"
  if [[ ! -f "$config" ]]; then
    sed -e 's/"dedicatedRooms": \[[^]]*\]/"dedicatedRooms": []/' \
      -e "s/\"slotBudget\": [0-9]*/\"slotBudget\": ${LFR_SLOT_BUDGET:-1}/" \
      "$release/config/bots/bot-1.example.json" >"$config"
    chown "$UID_GID" "$config"
    log "created $config (dryRun: true — nothing is posted until you set it to false)"
  fi
  chmod 600 "$DATA/.env" 2>/dev/null || true
}

port_guard() {
  local running
  running="$(docker ps --filter "name=^${NAME}$" --format '{{.Names}}' || true)"
  if ((${#REPLACE[@]} > 0)); then
    docker inspect "${REPLACE[@]}" >/dev/null 2>&1 || die "no such container among: ${REPLACE[*]}"
    return 0
  fi
  if [[ -z "$running" ]] && port_busy; then
    die "port $PORT is already used by something that is not $NAME: $(port_holder)
  If that is an older installation this release should take over, name its containers:
    LFR_REPLACE=<names>  (deploy-docker.ps1 -Replace <names> -DataRoot <its data dir>)"
  fi
}

firewall_hint() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw status | grep -qE "^${PORT}(/tcp)?\s+ALLOW" ||
      warn "ufw is active and does not allow $PORT/tcp — run: ufw allow $PORT/tcp"
  fi
}

# The app writes a generated first admin password beside the accounts file,
# owner-only. Show it to whoever is deploying, once, while it still exists.
show_first_password() {
  local file="$DATA/.control/initial-admin-password.txt"
  [[ -f "$file" ]] || return 0
  log '────────────────────────────────────────────────────────────'
  log "first admin login:  admin / $(cat "$file")"
  log "change it in the console, then delete $file"
  log '────────────────────────────────────────────────────────────'
}

prune() {
  local keep_live keep_prev
  keep_live="$(current_tag)"
  keep_prev="$(previous_tag)"
  mapfile -t old < <(ls -1t "$ROOT/releases" | tail -n "+$((KEEP + 1))")
  for tag in "${old[@]}"; do
    [[ "$tag" == "$keep_live" || "$tag" == "$keep_prev" ]] && continue
    rm -rf -- "${ROOT:?}/releases/$tag"
    docker image rm "$IMAGE:$tag" >/dev/null 2>&1 || true
  done
}

case "${1:-}" in
  --status) status; exit 0 ;;
  --rollback) rollback; exit 0 ;;
  '' | -*) die 'usage: release.sh <archive.tar> <commit> | --status | --rollback' ;;
esac

ARCHIVE="$1"
COMMIT="${2:-}"
[[ -f "$ARCHIVE" ]] || die "archive not found: $ARCHIVE"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "commit must be a full 40-hex sha, got: $COMMIT"
TAG="${COMMIT:0:12}"
RELEASE="$ROOT/releases/$TAG"

port_guard
mkdir -p "$ROOT/releases"
for dir in config config/bots .sessions .control; do
  [[ -d "$DATA/$dir" ]] && continue
  mkdir -p "$DATA/$dir"
  chown "$UID_GID" "$DATA/$dir"
done
printf '%s\n' "$DATA" >"$ROOT/data-root"
rm -rf -- "$RELEASE"
mkdir -p "$RELEASE"
tar -xf "$ARCHIVE" -C "$RELEASE"
first_install "$RELEASE"

log "building $IMAGE:$TAG (the running service is untouched until this finishes)"
# The image's own user matches the owner of the data, so the Deno cache it
# ships is writable at run time. A root-owned installation runs as root and
# keeps the image's default user for the cache (root can write it anyway).
user_args=()
if [[ "${UID_GID%%:*}" != 0 ]]; then
  user_args=(--build-arg "APP_UID=${UID_GID%%:*}" --build-arg "APP_GID=${UID_GID##*:}")
fi
docker build --network host -t "$IMAGE:$TAG" \
  --build-arg "GIT_COMMIT=$COMMIT" \
  --build-arg "BUILT_AT_MS=$(date +%s%3N)" \
  "${user_args[@]}" \
  "$RELEASE"

before="$(current_tag)"
stop_replaced
log "starting $NAME on port $PORT (data: $DATA, user $UID_GID)"
# `up` itself can fail after the old container is already gone (bad image,
# refused runtime setting), so its failure must reach the restore below too.
if ! switch_to "$TAG" || ! healthy; then
  warn "$TAG did not serve /account/login within ${HEALTH_TIMEOUT_S}s"
  docker logs --tail 40 "$NAME" >&2 || true
  if [[ -n "$before" && -d "$ROOT/releases/$before" ]]; then
    warn "restoring $before"
    switch_to "$before"
    healthy || warn "previous release is not healthy either"
  elif [[ -n "$(replaced)" ]]; then
    docker stop -t 30 "$NAME" >/dev/null 2>&1 || true
    start_replaced
  fi
  exit 1
fi

[[ -n "$before" && "$before" != "$TAG" ]] && printf '%s\n' "$before" >"$ROOT/previous-tag"
printf '%s\n' "$TAG" >"$ROOT/current-tag"
ln -sfn "$RELEASE" "$ROOT/current"
rm -f -- "$ARCHIVE"
prune
show_first_password
firewall_hint
log "live: $TAG  →  http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT/account/login"
status
