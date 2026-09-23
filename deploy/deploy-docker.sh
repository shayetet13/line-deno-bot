#!/usr/bin/env bash
# Deploy vps3's Docker stack (backend + front) from THIS checkout to the VPS.
#
# This is the only deploy path for vps3 — docker-compose.yml replaced the
# systemd lfr-worker/nginx units (see rollback-docker.sh). Never run this
# alongside re-enabling those systemd units: both bind :8791 and only one
# wins, crash-looping the loser (Playbook incident 2026-09-23).
#
# What it does:
#   1. Packs the exact source Dockerfile COPYs (apps/worker/src, packages,
#      vendor/linejs, deno.json, deno.lock) plus the compose/front files into
#      one tarball — never a bare rsync --delete, so files that exist only on
#      the VPS (.env, config/, .sessions/, .control/) are never touched.
#   2. Ships and extracts it over the existing tree on the VPS (overwrite,
#      not wipe-then-write, so a mid-transfer failure leaves the previous
#      source intact and still buildable).
#   3. Runs `docker compose build` with GIT_COMMIT/BUILT_AT_MS stamped from
#      this checkout, then `up -d`, then polls /api/health.
#   4. Prunes dangling images so old layers do not fill the disk.
#
# Usage:  deploy/deploy-docker.sh [--host IP] [--user root] [--identity FILE]
set -Eeuo pipefail

HOST="${DEPLOY_HOST:-172.237.2.229}"
SSH_USER="${DEPLOY_USER:-root}"
IDENTITY="${DEPLOY_IDENTITY:-deploy_vps_172_237_2_229_ed25519}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/linebot-docker/vps3}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-60}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) SSH_USER="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m[deploy-docker]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy-docker]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[deploy-docker] %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f deno.json ]] || die "run this from the project root (deno.json not found)"
[[ -f Dockerfile && -f docker-compose.yml ]] || die "Dockerfile/docker-compose.yml missing locally — pull them from the VPS first, this script will not invent them"
command -v ssh >/dev/null || die "ssh not found"
command -v scp >/dev/null || die "scp not found"
[[ -f "$IDENTITY" ]] || die "identity file not found: $IDENTITY"

GIT_COMMIT="unknown"
if git rev-parse --short=12 HEAD >/dev/null 2>&1; then
  GIT_COMMIT="$(git rev-parse --short=12 HEAD)"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    warn "working tree has uncommitted changes — building from disk state, not HEAD ($GIT_COMMIT)"
    GIT_COMMIT="${GIT_COMMIT}-dirty"
  fi
fi
BUILT_AT_MS="$(($(date +%s) * 1000))"
log "GIT_COMMIT=$GIT_COMMIT BUILT_AT_MS=$BUILT_AT_MS"

TMP_TAR="$(mktemp /tmp/vps3-deploy.XXXXXX.tar.gz)"
trap 'rm -f "$TMP_TAR"' EXIT

log "packing source (Dockerfile COPY list + compose/front files)"
tar czf "$TMP_TAR" \
  deno.json deno.lock \
  packages \
  vendor/linejs \
  apps/worker/src \
  Dockerfile docker-compose.yml .dockerignore \
  front

log "shipping to $SSH_USER@$HOST:$REMOTE_DIR"
scp -i "$IDENTITY" "$TMP_TAR" "$SSH_USER@$HOST:/tmp/vps3-deploy.tar.gz"

log "extracting, building, and rolling the stack on the VPS"
ssh -i "$IDENTITY" "$SSH_USER@$HOST" \
  GIT_COMMIT="$GIT_COMMIT" BUILT_AT_MS="$BUILT_AT_MS" REMOTE_DIR="$REMOTE_DIR" \
  HEALTH_TIMEOUT_S="$HEALTH_TIMEOUT_S" bash -s <<'REMOTE'
set -Eeuo pipefail
log()  { printf '\033[36m[deploy-docker@vps]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[deploy-docker@vps] %s\033[0m\n' "$*" >&2; exit 1; }

cd "$REMOTE_DIR"
[[ -f .env ]] || die ".env missing in $REMOTE_DIR — this holds runtime secrets and is never shipped by this script; create it once from .env.docker.example"

log "extracting source over the existing tree (overwrite, no wipe)"
tar xzf /tmp/vps3-deploy.tar.gz -C "$REMOTE_DIR"
rm -f /tmp/vps3-deploy.tar.gz

log "building images (GIT_COMMIT=$GIT_COMMIT)"
GIT_COMMIT="$GIT_COMMIT" BUILT_AT_MS="$BUILT_AT_MS" docker compose build

log "rolling backend + front"
GIT_COMMIT="$GIT_COMMIT" BUILT_AT_MS="$BUILT_AT_MS" docker compose up -d

log "waiting for health (up to ${HEALTH_TIMEOUT_S}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until curl -fsS --max-time 5 http://127.0.0.1:8791/api/health >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    die "worker never became healthy within ${HEALTH_TIMEOUT_S}s — check: docker compose logs backend --tail 100"
  fi
  sleep 2
done
log "healthy: $(curl -fsS --max-time 5 http://127.0.0.1:8791/api/health)"

log "pruning dangling images"
docker image prune -f >/dev/null

log "containers:"
docker compose ps
REMOTE

log "done"
