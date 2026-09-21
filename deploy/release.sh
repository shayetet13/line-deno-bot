#!/usr/bin/env bash
#
# Transactional release for line-first-response (Playbook §16).
#
# The ten steps that section asks for, in order, with the property that matters:
# nothing user-visible changes until the new release has already built, tested
# and validated its topology. The symlink swap is the commit point; anything
# after it that fails rolls the swap back.
#
#   usage:  release.sh <git-ref>            deploy that commit
#           release.sh --rollback           go back to the previous release
#           release.sh --status             show what is live
#
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/line-first-response}"
REPO="${REPO:-$APP_ROOT/repo}"
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
SERVICE="${SERVICE:-lfr-worker}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8791/api/health}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-60}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

export PATH="$HOME/.deno/bin:$PATH"

log()  { printf '\033[36m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[release]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[release] %s\033[0m\n' "$*" >&2; exit 1; }

# Isolated workers keep loopback ports outside release directories, next to
# their systemd metadata. Once template instances exist every active one must
# be restarted and pass readiness after a release swap.
instance_services() {
  systemctl list-units --type=service --state=active --no-legend 'lfr-worker@*.service' \
    | awk '{print $1}'
}

instance_port() {
  local unit="$1"
  local bot="${unit#lfr-worker@}"
  bot="${bot%.service}"
  local file="$APP_ROOT/.control/instances/$bot.env"
  [[ -f "$file" ]] || return 1
  sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' "$file" | head -n 1
}

# --- health check -----------------------------------------------------------
# Step 8: process, listener, and the worker's own readiness. A process that is
# up but not ARMED is not a successful deploy — it just is not answering yet.
health_check() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  local -a instances=()
  mapfile -t instances < <(instance_services)

  while (( SECONDS < deadline )); do
    if (( ${#instances[@]} > 0 )); then
      local healthy=1
      local service port
      for service in "${instances[@]}"; do
        port="$(instance_port "$service" || true)"
        if ! systemctl is-active --quiet "$service" || [[ -z "$port" ]] || \
          ! curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
          healthy=0
          break
        fi
      done
      if (( healthy == 1 )); then
        log "healthy: ${#instances[@]} isolated worker instance(s)"
        return 0
      fi
      sleep 2
      continue
    fi
    if ! systemctl is-active --quiet "$SERVICE"; then
      sleep 2
      continue
    fi
    local body
    if body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
      # /api/health answers 200 only when readiness is ARMED, so a successful
      # curl here means every precondition holds, not merely that a port is open.
      log "healthy: $body"
      return 0
    fi
    sleep 2
  done

  warn "no healthy response from $HEALTH_URL within ${HEALTH_TIMEOUT_S}s"
  systemctl status "$SERVICE" --no-pager --lines=20 >&2 || true
  return 1
}

# Swaps `current` atomically. ln -sfn onto a temp name then mv is the only way
# to replace a symlink without a window where it does not exist.
swap_current() {
  local target="$1"
  ln -sfn "$target" "$CURRENT.tmp"
  mv -Tf "$CURRENT.tmp" "$CURRENT"
}

restart_service() {
  # Every active isolated worker must reload the new target, not just one.
  local -a instances=()
  mapfile -t instances < <(instance_services)
  if (( ${#instances[@]} == 0 )); then
    systemctl restart "$SERVICE"
  else
    systemctl restart "${instances[@]}"
  fi
}

# `readlink -f` happily prints a path for a link that does not exist, which
# would make "(none)" impossible to tell from a real release.
resolve_link() {
  [[ -L "$1" ]] && readlink -f "$1" || true
}

show_status() {
  printf 'current:  %s\n' "$(resolve_link "$CURRENT" || true)"
  printf 'previous: %s\n' "$(resolve_link "$PREVIOUS" || true)"
  printf 'service:  %s\n' "$(systemctl is-active "$SERVICE" 2>/dev/null || echo unknown)"
  curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || printf 'health:   unreachable\n'
}

do_rollback() {
  # Step 10: the previous symlink is the rollback target, kept for exactly this.
  [[ -L "$PREVIOUS" ]] || die "no previous release to roll back to"
  local target
  target="$(resolve_link "$PREVIOUS")"
  [[ -d "$target" ]] || die "previous release $target is gone"

  log "rolling back to $target"
  local failed
  failed="$(resolve_link "$CURRENT")"
  swap_current "$target"
  restart_service

  if health_check; then
    ln -sfn "$failed" "$PREVIOUS"
    log "rollback complete"
    return 0
  fi
  die "ROLLBACK ALSO UNHEALTHY — manual intervention required (was: ${failed:-unknown})"
}

do_release() {
  local ref="$1"

  command -v deno >/dev/null || die "deno not on PATH"
  [[ -d "$REPO/.git" ]] || die "no git repo at $REPO"

  # Step 1 & 2: deploy from a commit, never from a dirty tree. A dirty build
  # cannot be reproduced, which means it cannot be rolled back to either.
  git -C "$REPO" fetch --all --tags --prune
  local commit
  commit="$(git -C "$REPO" rev-parse --verify "${ref}^{commit}")" \
    || die "cannot resolve ref '$ref' to a commit"

  local stamp release
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  release="$RELEASES/${stamp}-${commit:0:12}"

  # Step 3: build into its own directory. The live release is untouched until
  # the swap, so a failure here costs nothing.
  log "building $commit → $release"
  mkdir -p "$release"
  git -C "$REPO" archive "$commit" | tar -x -C "$release"

  # The vendored LINEJS submodule is pinned; take it from the repo checkout
  # rather than the network so the build matches the recorded revision.
  local linejs_commit=""
  if [[ -d "$REPO/vendor/linejs" ]]; then
    # A latency fix may pin our maintained LINEJS fork; sync the configured
    # URL before fetching the gitlink so an older checkout cannot keep using
    # the upstream remote from .git/config.
    git -C "$REPO" submodule sync --recursive >/dev/null
    git -C "$REPO" submodule update --init --recursive >/dev/null
    # Resolve from the release target, never the repo checkout's current HEAD.
    # Deploying an explicit SHA while HEAD lagged once stamped and copied the
    # previous dependency even though the application archive was new.
    linejs_commit="$(git -C "$REPO" rev-parse "${commit}:vendor/linejs" 2>/dev/null || true)"
    if [[ -n "$linejs_commit" ]]; then
      git -C "$REPO/vendor/linejs" fetch origin "$linejs_commit" >/dev/null
      git -C "$REPO/vendor/linejs" checkout --detach "$linejs_commit" >/dev/null
    fi
    # `git archive` already extracted an EMPTY vendor/linejs/ (the submodule's
    # tree entry has no content). `cp -a src dst` onto an existing directory
    # nests src inside dst instead of populating it, so copy CONTENTS with a
    # trailing "/." rather than the directory itself.
    mkdir -p "$release/vendor/linejs"
    cp -a "$REPO/vendor/linejs/." "$release/vendor/linejs/"
  fi

  # A `git archive` extract has no .git, so the worker cannot ask git what it
  # is running — stamp it, including the submodule pin, or the release
  # manifest reports "unknown" for a dependency that is in fact pinned right
  # here, which would let assertDeployable() wave through an untraceable build.
  echo "{\"commit\":\"$commit\",\"linejs\":\"$linejs_commit\",\"builtAtMs\":$(date +%s000)}" \
    > "$release/.release.json"

  # Credentials, human accounts, and per-bot config live outside the release
  # and are symlinked in: a release directory must never contain a copy of
  # either a LINE session or the system user database.
  ln -sfn "$APP_ROOT/config" "$release/config"
  ln -sfn "$APP_ROOT/.sessions" "$release/.sessions"
  ln -sfn "$APP_ROOT/.control" "$release/.control"
  if [[ -f "$APP_ROOT/.env" ]]; then ln -sfn "$APP_ROOT/.env" "$release/.env"; fi

  # Step 4: the full gate, plus the acceptance table, before anything switches.
  log "running gate in the new release"
  ( cd "$release" && deno task gate ) || die "gate failed — nothing was switched"

  # Step 5: topology and acceptance. A shard map that overlaps would have two
  # workers answering for one owner.
  log "running acceptance"
  ( cd "$release" && deno task acceptance ) || die "acceptance failed — nothing was switched"

  # Step 6: the commit point.
  local outgoing
  outgoing="$(resolve_link "$CURRENT")"
  log "switching current → $release"
  swap_current "$release"

  restart_service

  # Steps 8 & 9: if it does not come up healthy, undo the whole transaction.
  if ! health_check; then
    warn "new release unhealthy — rolling the transaction back"
    if [[ -n "$outgoing" && -d "$outgoing" ]]; then
      swap_current "$outgoing"
      restart_service
      health_check || die "ROLLBACK ALSO UNHEALTHY — manual intervention required"
      die "deploy of $commit failed and was rolled back to $outgoing"
    fi
    die "deploy of $commit failed and there was no previous release to restore"
  fi

  if [[ -n "$outgoing" ]]; then ln -sfn "$outgoing" "$PREVIOUS"; fi
  log "deployed $commit"

  # Keep a few releases so a rollback has somewhere to go; drop the rest.
  local keep_from=$((KEEP_RELEASES + 1))
  ( cd "$RELEASES" && ls -1dt -- */ 2>/dev/null | tail -n "+$keep_from" | while read -r old; do
      old="${old%/}"
      resolved="$(readlink -f "$RELEASES/$old")"
      [[ "$resolved" == "$(resolve_link "$CURRENT")" ]] && continue
      [[ "$resolved" == "$(resolve_link "$PREVIOUS")" ]] && continue
      log "pruning old release $old"
      rm -rf -- "${RELEASES:?}/$old"
    done ) || true
}

main() {
  mkdir -p "$RELEASES"
  case "${1:-}" in
    --rollback) do_rollback ;;
    --status)   show_status ;;
    ''|--help|-h)
      sed -n '3,12p' "$0" | sed 's/^# \?//'
      ;;
    -*) die "unknown option $1" ;;
    *)  do_release "$1" ;;
  esac
}

main "$@"
