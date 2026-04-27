# syntax=docker/dockerfile:1.7

# ----- Stage 1: build the React SPA -------------------------------------
FROM node:20-alpine AS web-builder
WORKDIR /web

# Use pnpm via corepack (matches the host workflow).
RUN corepack enable

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

# Install uv (used to manage the Python env, same as the host workflow).
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Project metadata + lock first so the deps layer caches independent of
# source-only changes. README.md is referenced by pyproject.toml's
# `readme` field so it has to be present at sync time.
COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/
RUN uv sync --frozen --no-dev

# Copy the built SPA from stage 1 so FastAPI's static-file mount finds it.
COPY --from=web-builder /web/dist ./web/dist

# Container-only env. Host CLI keeps its existing defaults (Path.home()
# for data/briefings, 127.0.0.1 for serve, Keychain for auth) — these
# only kick in here.
ENV LOCAL_FITNESS_HOST=0.0.0.0 \
    LOCAL_FITNESS_DATA_DIR=/data \
    LOCAL_FITNESS_BRIEFINGS_DIR=/briefings \
    PYTHONUNBUFFERED=1

# Pre-create the volume mount points so the bind-mounts can attach
# cleanly on first run.
RUN mkdir -p /data /briefings /root/.garminconnect /root/.claude

EXPOSE 8765

# Healthcheck: the /health endpoint is a cheap liveness probe — it does
# not touch DB or external services. Traefik also has its own healthcheck
# defined in the compose file; this one is for `docker ps` visibility.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8765/health || exit 1

CMD ["uv", "run", "fitness", "serve"]
