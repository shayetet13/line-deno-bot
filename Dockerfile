# syntax=docker/dockerfile:1
# vps3 — line-first-response worker (Deno + vendored LINEJS), multi-user console.
# Worker only: the operator console is served by the worker itself; the TLS
# edge (nginx) lives on the AWS box, so no web server shares this host's CPU.
# All mutable state (config, LINE sessions, user registry) is bind-mounted —
# nothing secret is ever baked into an image layer (see .dockerignore).

ARG DENO_VERSION=2.9.7

FROM denoland/deno:${DENO_VERSION}

ARG APP_UID=1000
ARG APP_GID=1000
# `deno.json` version + these stamps are what /api/status reports as the build.
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

# Resolve and cache every npm/jsr dependency now (lockfile enforced), so a
# container start never depends on the network or drifts from deno.lock.
RUN deno cache --frozen apps/worker/src/cli/serve.ts \
	&& printf '{"commit":"%s","linejs":"%s","builtAtMs":%s}\n' \
		"${GIT_COMMIT}" "${LINEJS_COMMIT}" "${BUILT_AT_MS}" > .release.json \
	&& mkdir -p config .sessions .control \
	# DENO_DIR is inherited from the base image (/deno-dir/) — chown it here,
	# not with a hardcoded path, so this still works if the base image moves it.
	&& chown -R lfr:lfr /app "${DENO_DIR}"

USER lfr
ENV HEALTH_URL=http://127.0.0.1:8791/api/health

# Any HTTP answer proves the console is listening; only a refused connection
# or timeout is unhealthy.
HEALTHCHECK --interval=30s --timeout=6s --start-period=40s --retries=3 \
	CMD ["deno", "eval", "await fetch(Deno.env.get('HEALTH_URL')!,{signal:AbortSignal.timeout(4000)}).then(()=>Deno.exit(0),()=>Deno.exit(1))"]

# --cached-only: refuse any dependency not already resolved by the `deno
# cache --frozen` above, so a container that starts clearly errors instead of
# silently downloading from npm/jsr at runtime (the whole point of caching
# at build time). Remaining flags (config, ports, --multi-bot, --host) come
# from docker-compose `command:`.
ENTRYPOINT ["deno", "run", "-A", "--cached-only", "apps/worker/src/cli/serve.ts"]
