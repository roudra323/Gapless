# The API image (docs/07 "Docker"). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t gapless-api .
# The migrations run from the indexer image only (the migrate Job, Phase 8).

# Build stages: Node 24.22.2 (.nvmrc) on Debian 13, the same Debian as the runtime image.
# The base and deps stages are the same as in apps/indexer/Dockerfile, so the two builds share
# those cached layers and the pnpm store cache.
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# Corepack takes the pnpm version (and checks its hash) from the `packageManager` field. The first
# `pnpm` call downloads the pnpm 12 binary, so it is in this layer and not fetched in every stage.
COPY package.json ./
RUN corepack enable && pnpm --version

# 1. deps: download every package in the lockfile into the pnpm store. Only the lockfile and the
#    workspace file are copied, so this layer is rebuilt only when the dependencies change.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

# 2. build: install from the store (no network) and compile the API and its packages.
#    --ignore-scripts: the root `prepare` (lefthook install) needs .git, which is not in the
#    context. Dependency build scripts are already blocked by `allowBuilds`.
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --ignore-scripts --store-dir /pnpm/store
RUN pnpm --filter @gapless/api... build

# 3. prod: the API with its production dependencies only, in /out. Not --offline: deploy checks
#    the lockfile against the supply-chain policy (minimumReleaseAge), which needs registry metadata.
FROM build AS prod
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --filter @gapless/api --prod --store-dir /pnpm/store /out

# 4. runtime: distroless Node, no shell or package manager, user 65532 (nonroot).
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba AS runtime
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.source="https://github.com/roudra323/Gapless" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.title="gapless-api"
ENV NODE_ENV=production \
    APP_VERSION=${GIT_SHA}
WORKDIR /app
COPY --from=prod /out ./
USER 65532:65532
# 3000: the public /v1/* port (PORT). 9464: /healthz, /readyz and /metrics (METRICS_PORT), never
# routed by the Gateway.
EXPOSE 3000 9464
# The base image's ENTRYPOINT is /nodejs/bin/node, so CMD is only the script (exec form: Node is
# PID 1 and gets SIGTERM directly).
CMD ["dist/main.js"]
