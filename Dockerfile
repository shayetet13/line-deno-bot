# syntax=docker/dockerfile:1
# line-first-response multi-user console + bots, one container.
# Build context is a `git archive` of one commit (deploy/deploy-docker.ps1), so
# nothing untracked — sessions, accounts, real bot configs — can reach a layer.
# All mutable state is bind-mounted by deploy/docker/compose.yml.

ARG DENO_VERSION=2.9.7
ARG NODE_VERSION=22

# The account-wide /PUSH stream runs through a small Node HTTP/2 sidecar
# (apps/worker/src/transport/node-h2-sidecar.mjs). Without `node` in the image
# PUSH never opens and only the dedicated room polls receive anything. Copied
# from the official image rather than apt-installed: no mirror dependency at
# build time, and the same Node major as development.
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM denoland/deno:debian-${DENO_VERSION}
COPY --from=node /usr/local/bin/node /usr/local/bin/node

ARG APP_UID=1000
ARG APP_GID=1000
ARG GIT_COMMIT=unknown
ARG LINEJS_COMMIT=ef6c3d9
ARG BUILT_AT_MS=0

RUN groupadd --gid "${APP_GID}" lfr \
	&& useradd --uid "${APP_UID}" --gid lfr --no-create-home --shell /usr/sbin/nologin lfr

WORKDIR /app
COPY deno.json deno.lock ./
COPY packages ./packages
COPY vendor/linejs ./vendor/linejs
COPY apps/worker/src ./apps/worker/src

# Resolve every npm/jsr dependency now (lockfile enforced). The bot shard entry
# is loaded with `new Worker(...)` at runtime, so its graph is cached too.
RUN deno cache --frozen apps/worker/src/cli/serve.ts apps/worker/src/bots/shard-worker.ts \
	&& printf '{"commit":"%s","linejs":"%s","builtAtMs":%s}\n' \
		"${GIT_COMMIT}" "${LINEJS_COMMIT}" "${BUILT_AT_MS}" > .release.json \
	&& mkdir -p config .sessions .control \
	&& chown -R lfr:lfr /app "${DENO_DIR}"

USER lfr
ENV HEALTH_URL=http://127.0.0.1:8793/account/login

# Any HTTP answer from the login page proves the console is serving. (/api/health
# is 503 until a LINE session is ARMED, which a fresh install is not.)
HEALTHCHECK --interval=30s --timeout=6s --start-period=60s --retries=3 \
	CMD ["deno", "eval", "await fetch(Deno.env.get('HEALTH_URL')!,{signal:AbortSignal.timeout(4000)}).then((r)=>Deno.exit(r.status<500?0:1),()=>Deno.exit(1))"]

# --cached-only: a container never downloads code at runtime.
ENTRYPOINT ["deno", "run", "-A", "--cached-only", "apps/worker/src/cli/serve.ts"]
