#!/usr/bin/env bash
# Server side of deploy/deploy-docker.ps1. Builds one commit into an image,
# swaps the running container, health-checks it, and rolls back on failure.
#
#   bash release.sh <archive.tar> <commit>   deploy that commit
#   bash release.sh --status                  what is live
#   bash release.sh --rollback                back to the previous release
#
# Environment: LFR_PORT (8793), LFR_ROOT (/opt/lfr-$LFR_PORT), KEEP_RELEASES (5),
# LFR_SLOT_BUDGET (1 — polled rooms per bot for a brand-new install; see
# docs/runbook.md §10 for why a 2-vCPU host wants 1).
set -Eeuo pipefail

PORT="${LFR_PORT:-8793}"
ROOT="${LFR_ROOT:-/opt/lfr-$PORT}"
KEEP="${KEEP_RELEASES:-5}"
UID_GID="${LFR_UID:-1000}:${LFR_GID:-1000}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
IMAGE=line-first-response
NAME="lfr-$PORT"

log() { printf '\033[36m[docker-release]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[docker-release]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[docker-release]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die 'run as root'
command -v docker >/dev/null || die 'docker is not installed'
docker compose version >/dev/null 2>&1 || die 'docker compose v2 is required'
[[ "$PORT" =~ ^[0-9]+$ ]] || die "LFR_PORT must be a number, got $PORT"

compose() {
  local release="$1" tag="$2"
  shift 2
  LFR_ROOT="$ROOT" LFR_PORT="$PORT" IMAGE_TAG="$tag" \
    LFR_UID="${UID_GID%%:*}" LFR_GID="${UID_GID##*:}" \
    docker compose -f "$release/deploy/docker/compose.yml" "$@"
}

healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) code
  while ((SECONDS < deadline)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:$PORT/account/login" || true)"
    [[ "$code" == 200 ]] && return 0
    sleep 2
  done
  return 1
}

current_tag() { cat "$ROOT/current-tag" 2>/dev/null || true; }
previous_tag() { cat "$ROOT/previous-tag" 2>/dev/null || true; }

status() {
  printf 'root:     %s\n' "$ROOT"
  local live prev
  live="$(current_tag)"
  prev="$(previous_tag)"
  printf 'live:     %s\n' "${live:-none}"
  printf 'previous: %s\n' "${prev:-none}"
  docker ps --filter "name=^${NAME}$" --format 'container: {{.Names}} {{.Status}} {{.Image}}' || true
  curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health" || true
  echo
}

switch_to() {
  local tag="$1"
  compose "$ROOT/releases/$tag" "$tag" up -d --force-recreate --remove-orphans
}

rollback() {
  local prev
  prev="$(previous_tag)"
  [[ -n "$prev" && -d "$ROOT/releases/$prev" ]] || die 'no previous release to roll back to'
  log "rolling back to $prev"
  switch_to "$prev" && healthy ||
    die "previous release $prev is not healthy either — see: docker logs $NAME"
  printf '%s\n' "$(current_tag)" >"$ROOT/previous-tag"
  printf '%s\n' "$prev" >"$ROOT/current-tag"
  ln -sfn "$ROOT/releases/$prev" "$ROOT/current"
  log "rolled back; live is $prev"
}

# A brand-new install gets a config that answers nothing and posts nothing
# (dryRun) until its owner picks rooms, and an admin password that is not the
# one written in the repository.
first_install() {
  local release="$1" config="$ROOT/config/bots/bot-1.json"
  if [[ ! -f "$config" ]]; then
    sed -e 's/"dedicatedRooms": \[[^]]*\]/"dedicatedRooms": []/' \
      -e "s/\"slotBudget\": [0-9]*/\"slotBudget\": ${LFR_SLOT_BUDGET:-1}/" \
      "$release/config/bots/bot-1.example.json" >"$config"
    log "created $config (dryRun: true — nothing is posted until you set it to false)"
  fi
  if [[ ! -f "$ROOT/.control/users.json" ]] && ! grep -q '^LFR_ADMIN_PASSWORD=' "$ROOT/.env" 2>/dev/null; then
    local password
    password="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
    (umask 077 && printf 'LFR_ADMIN_PASSWORD=%s\n' "$password" >>"$ROOT/.env")
    log '────────────────────────────────────────────────────────────'
    log "first admin login:  admin / ${password}"
    log "(stored in $ROOT/.env; change it in the console after logging in)"
    log '────────────────────────────────────────────────────────────'
  fi
  chmod 600 "$ROOT/.env" 2>/dev/null || true
}

port_guard() {
  local running
  running="$(docker ps --filter "name=^${NAME}$" --format '{{.Names}}' || true)"
  if [[ -z "$running" ]] && ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
    die "port $PORT is already used by something that is not $NAME: $(ss -ltnp "sport = :$PORT" | tail -1)"
  fi
}

firewall_hint() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw status | grep -qE "^${PORT}(/tcp)?\s+ALLOW" ||
      warn "ufw is active and does not allow $PORT/tcp — run: ufw allow $PORT/tcp"
  fi
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
mkdir -p "$ROOT/config/bots" "$ROOT/.sessions" "$ROOT/.control" "$ROOT/releases"
rm -rf -- "$RELEASE"
mkdir -p "$RELEASE"
tar -xf "$ARCHIVE" -C "$RELEASE"
first_install "$RELEASE"
chown -R "$UID_GID" "$ROOT/config" "$ROOT/.sessions" "$ROOT/.control"

log "building $IMAGE:$TAG"
docker build --network host -t "$IMAGE:$TAG" \
  --build-arg "GIT_COMMIT=$COMMIT" \
  --build-arg "BUILT_AT_MS=$(date +%s%3N)" \
  --build-arg "APP_UID=${UID_GID%%:*}" --build-arg "APP_GID=${UID_GID##*:}" \
  "$RELEASE"

before="$(current_tag)"
log "starting $NAME on port $PORT"
# `up` itself can fail after the old container is already gone (bad image,
# refused runtime setting), so its failure must reach the restore below too.
if ! switch_to "$TAG" || ! healthy; then
  warn "$TAG did not serve /account/login within ${HEALTH_TIMEOUT_S}s"
  docker logs --tail 40 "$NAME" >&2 || true
  if [[ -n "$before" && -d "$ROOT/releases/$before" ]]; then
    warn "restoring $before"
    switch_to "$before"
    healthy || warn "previous release is not healthy either"
  fi
  exit 1
fi

[[ -n "$before" && "$before" != "$TAG" ]] && printf '%s\n' "$before" >"$ROOT/previous-tag"
printf '%s\n' "$TAG" >"$ROOT/current-tag"
ln -sfn "$RELEASE" "$ROOT/current"
rm -f -- "$ARCHIVE"
prune
firewall_hint
log "live: $TAG  →  http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT/account/login"
status
