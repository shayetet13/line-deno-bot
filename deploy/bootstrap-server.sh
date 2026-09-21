#!/usr/bin/env bash
# Prepares a fresh Linux host to run the line-first-response worker.
#
# Idempotent: safe to re-run. Installs Deno, enforces NTP-grade time sync
# (the whole reason we measure on a server rather than a dev laptop), and
# verifies the checkout by running the project gate.
#
#   bash deploy/bootstrap-server.sh
#
# Run it from the project root, after the code has been delivered to the host.

set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }

# ── 1. Deno ──────────────────────────────────────────────────────────────────
log 'Deno'
if command -v deno >/dev/null 2>&1; then
  echo "already installed: $(deno --version | head -1)"
else
  curl -fsSL https://deno.land/install.sh | sh -s -- --yes
  export DENO_INSTALL="${HOME}/.deno"
  export PATH="${DENO_INSTALL}/bin:${PATH}"
  # Make it stick for future shells without duplicating the block.
  if ! grep -q 'DENO_INSTALL' "${HOME}/.bashrc" 2>/dev/null; then
    {
      echo 'export DENO_INSTALL="$HOME/.deno"'
      echo 'export PATH="$DENO_INSTALL/bin:$PATH"'
    } >>"${HOME}/.bashrc"
  fi
  echo "installed: $(deno --version | head -1)"
fi

# ── 2. Time sync ─────────────────────────────────────────────────────────────
# Without sub-millisecond sync, `inbound` measurements are meaningless against
# an 11ms budget — this step is the point of moving off the dev box.
log 'Time synchronisation'
if command -v chronyc >/dev/null 2>&1; then
  echo 'chrony present'
elif command -v timedatectl >/dev/null 2>&1 && timedatectl show -p NTP --value | grep -q yes; then
  echo 'systemd-timesyncd active'
else
  warn 'no time daemon found — installing chrony'
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y chrony
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y chrony
  else
    warn 'unknown package manager; install chrony manually, then re-run'
  fi
fi

if command -v chronyc >/dev/null 2>&1; then
  sudo systemctl enable --now chronyd 2>/dev/null || sudo systemctl enable --now chrony 2>/dev/null || true
  sleep 2
  echo
  chronyc tracking || warn 'chronyc tracking failed'
  echo
  echo 'Look at "System time" above — it must be well under 1 millisecond.'
  echo 'If it is not, wait for chrony to settle and re-check before measuring.'
else
  timedatectl status || true
  warn 'systemd-timesyncd is coarser than chrony; prefer chrony for latency work'
fi

# ── 3. Checkout sanity ───────────────────────────────────────────────────────
log 'Checkout'
if [ ! -f deno.json ]; then
  echo 'error: run this from the project root (deno.json not found)' >&2
  exit 1
fi
if [ ! -f vendor/linejs/deno.json ]; then
  if [ -d .git ]; then
    echo 'vendored LINEJS missing — initialising submodule'
    git submodule update --init --recursive
  else
    echo 'error: vendor/linejs is missing and this is not a git checkout' >&2
    echo '       re-sync the project including vendor/linejs' >&2
    exit 1
  fi
fi
echo "linejs pinned at: $(git -C vendor/linejs rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

# ── 4. Gate ──────────────────────────────────────────────────────────────────
log 'Gate'
deno task gate

log 'Ready'
cat <<'EOF'
Next:
  1. Put the LINE session in place (see deploy/README.md), or log in fresh:
       deno task login --bot-id bot-1 --method qr
  2. Measure:
       deno task probe --bot-id bot-1 --seconds 180

  Do NOT run the probe here and on another machine at the same time with the
  same account — LINE may invalidate one of the sessions.
EOF
