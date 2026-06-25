# syntax=docker/dockerfile:1.7

# ----- Stage 1: build the React SPA -------------------------------------
# Debian (glibc), not Alpine (musl): Vite 8 bundles with rolldown, whose
# native binding ships per-platform. The musl binding fails to resolve under
# pnpm on alpine (MODULE_NOT_FOUND at `vite build`); the gnu binding on slim
# is the supported, well-tested path.
FROM node:26-bookworm-slim AS web-builder
WORKDIR /web

# Use pnpm via corepack (matches the host workflow). node:26 dropped the
# bundled corepack shim, so install it explicitly before enabling — it then
# honors the `packageManager: pnpm@x` pin in web/package.json.
RUN npm install -g corepack@latest && corepack enable

# Harden the registry fetch: rolldown's platform-specific native binding is
# an OPTIONAL dependency, so a flaky download makes `pnpm install` succeed
# with the .node binary missing — `vite build` then dies with MODULE_NOT_FOUND.
# More retries / longer timeouts make the optional-binding fetch reliable.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=300000

# Cache deps layer when only source changes
COPY web/package.json web/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy the rest of the frontend and build
COPY web/ ./
RUN pnpm build


# ----- Stage 2: runtime -------------------------------------------------
FROM python:3.12-slim AS runtime

# System deps:
#  - curl: needed for the healthcheck and the uv installer.
#  - ca-certificates / gnupg: nodesource repo signing.
#  - nodejs: required because the Claude Agent SDK shells out to the
#    `claude` CLI, which is published via npm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pin the Claude Code CLI to the version the SDK expects (see
# claude_agent_sdk/_cli_version.py). Bump in lockstep with the SDK.
RUN npm install -g @anthropic-ai/claude-code@2.1.119

# Install uv into a system path so the non-root user picks it up too.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Non-root user. The claude CLI refuses --dangerously-skip-permissions
# (which the Agent SDK passes for permission_mode="bypassPermissions")
# when uid==0, so the container must run as a regular user.
RUN useradd --create-home --shell /bin/bash --uid 1001 app

WORKDIR /app

# Project metadata + lock first so the deps layer caches independent of
# source-only changes. README.md is referenced by pyproject.toml's
# `readme` field so it has to be present at sync time.
COPY --chown=app:app pyproject.toml uv.lock README.md ./
COPY --chown=app:app src/ ./src/
# Harden the dependency download against a slow/flaky build network: a
# longer per-request timeout plus reduced concurrency so the large wheels
# (claude-agent-sdk is ~73 MB) don't saturate the link and reset the batch.
ENV UV_HTTP_TIMEOUT=180 \
    UV_CONCURRENT_DOWNLOADS=4
RUN chown app:app /app && su app -c "uv sync --frozen --no-dev"

# Copy the built SPA from stage 1 so FastAPI's static-file mount finds it.
COPY --from=web-builder --chown=app:app /web/dist ./web/dist

# Container-only env. Host CLI keeps its existing defaults (Path.home()
# for data/briefings, 127.0.0.1 for serve, Keychain for auth) — these
# only kick in here.
ENV LOCAL_FITNESS_HOST=0.0.0.0 \
    LOCAL_FITNESS_DATA_DIR=/data \
    LOCAL_FITNESS_BRIEFINGS_DIR=/briefings \
    PYTHONUNBUFFERED=1

# Pre-create the volume mount points so the bind-mounts can attach
# cleanly on first run, and own them as `app` so writes succeed.
RUN mkdir -p /data /briefings /home/app/.garminconnect /home/app/.claude \
    && chown -R app:app /data /briefings /home/app/.garminconnect /home/app/.claude

USER app

EXPOSE 8765

# Healthcheck: the /health endpoint is a cheap liveness probe — it does
# not touch DB or external services. Traefik also has its own healthcheck
# defined in the compose file; this one is for `docker ps` visibility.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8765/health || exit 1

CMD ["uv", "run", "fitness", "serve"]
