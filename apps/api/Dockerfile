# syntax=docker/dockerfile:1.7

# Keep the build and runtime on the same Linux family so native dependencies
# such as bcrypt and sharp are compatible when copied between stages.
FROM node:22-bookworm-slim AS base

ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Reduce this monorepo to the API and the workspaces it depends on. This keeps
# web and mobile dependencies out of the API image.
FROM base AS pruner

RUN npm install --global turbo@2.5.4

COPY . .

RUN turbo prune api --docker

# Install, generate Prisma, and compile TypeScript. DATABASE_URL is required
# while Prisma loads its config, but no database connection is opened by
# `prisma generate` or the Nest build.
FROM base AS builder

ENV DATABASE_URL=postgresql://postgres:postgres@localhost:5432/pharmaceylon

COPY --from=pruner /app/out/json/ ./

# The root prepare script needs shared source files, so lifecycle scripts are
# delayed until the complete pruned source tree has been copied.
RUN npm ci --ignore-scripts

COPY --from=pruner /app/out/full/ ./

RUN npm rebuild \
    && npm run build -w @pharmaceylon/shared \
    && npm run build -w api \
    && npm prune --omit=dev --ignore-scripts

# The final stage contains runtime dependencies and compiled output only.
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3001

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist

RUN mkdir -p /app/apps/api/storage/uploads \
    && chown -R node:node /app/apps/api/storage

USER node
WORKDIR /app/apps/api

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/v1/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/main.js"]

