# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Keep only the web workspace and its monorepo dependencies.
FROM base AS pruner

RUN npm install --global turbo@2.5.4

COPY . .

RUN turbo prune web --docker

# NEXT_PUBLIC_* is embedded into browser JavaScript during `next build`.
# API_PROXY_TARGET is used to generate Next's server-side rewrite manifest.
FROM base AS builder

ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
ARG API_PROXY_TARGET=http://api:3001

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    API_PROXY_TARGET=${API_PROXY_TARGET} \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=pruner /app/out/json/ ./

# Delay lifecycle scripts until shared workspace source files are present.
RUN npm ci --ignore-scripts

COPY --from=pruner /app/out/full/ ./

RUN npm rebuild \
    && npm run build -w @pharmaceylon/shared \
    && npm run build -w web

# Next standalone output contains the traced runtime dependencies and server.
FROM base AS runtime

ARG IMAGE_REVISION=local
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
LABEL org.opencontainers.image.source="https://github.com/ShafeekSaleem/PharmaCeylon" \
    org.opencontainers.image.revision=${IMAGE_REVISION} \
    io.pharmaceylon.api-base=${NEXT_PUBLIC_API_BASE_URL}

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

USER node
WORKDIR /app/apps/web

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "server.js"]
