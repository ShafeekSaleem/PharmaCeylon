# PharmaCeylon

Monorepo for the PharmaCeylon pharmacy management platform.

## Stack

- **API:** NestJS, Prisma, PostgreSQL (JWT access + refresh)
- **Web:** Next.js (marketing + app)
- **Mobile:** Expo (React Native)
- **Tooling:** Turborepo, npm workspaces

## Repository layout

```
apps/
  api/      NestJS + Prisma
  web/      Next.js
  mobile/   Expo
packages/
  shared/   Shared types and utilities
```

## Prerequisites

- Node.js 20+
- Docker Desktop with Docker Compose (recommended for local PostgreSQL)
- PostgreSQL 16+ when not using Docker
- Redis 7+ (optional; reserved for future features)

## Setup

1. Start PostgreSQL with Docker:

   ```bash
   cp .env.docker.example .env.docker
   docker compose --env-file .env.docker up -d db
   ```

   Windows PowerShell users can replace `cp` with `Copy-Item`. See
   **[docs/DOCKER.md](docs/DOCKER.md)** for the beginner walkthrough, verification,
   daily commands, data persistence, and troubleshooting.

2. Install dependencies from the repo root:

   ```bash
   npm install
   ```

   This runs `prepare`, which builds `@pharmaceylon/shared` once so Nest/Next can import it.

3. Copy environment examples and fill in values:

   - `apps/api/.env.example` → `apps/api/.env`
   - `apps/web/.env.example` → `apps/web/.env.local`

4. Run database migrations and generate the Prisma client from the repository root:

   ```bash
   npm run prisma:migrate -w api
   npm run prisma:generate -w api
   ```

5. Align Expo native dependency versions (recommended after install):

   ```bash
   cd apps/mobile
   npx expo install
   ```

For database seeding, API/web URLs, CORS, and signing in locally with the Next app, see **[docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)**.

## Development

From the repository root:

```bash
npm run dev
```

Run individual apps:

```bash
cd apps/api && npm run start:dev
cd apps/web && npm run dev
cd apps/mobile && npx expo start
```

Run the complete local web stack in Docker:

```bash
npm run docker:config
npm run docker:up
npm run docker:check
```

Compose starts PostgreSQL, runs the one-shot migration job, starts the API, and
then starts Next.js, waiting for healthy services. Keep your existing `.env.docker`
and chosen ports; create it from the example only on a new checkout. Stop
host-running API/web processes before publishing ports `3001` and `3000`.
`npm run docker:ps` includes the completed migration job; `npm run docker:logs`
follows logs. `npm run docker:down` removes containers but preserves database and
upload volumes. No npm helper resets or seeds data automatically. See
**[docs/DOCKER.md](docs/DOCKER.md)** for the Docker learning walkthrough.

## Versioned Docker images (Phase 6)

CI builds and tests changes targeting `develop` or `main`. Docker stack testing,
image scanning, and publication run only after a successful push to `main`.
Successful merged PRs to `main` publish matching API, migration, and web images
to GHCR, then verify the pulled digests in a source-free bundle. The verified
`release-bundle` Actions artifact includes Compose configuration, a digest-pinned
release lock and helper commands; application source and `npm install` are not
required to run it.

Keep using `npm run docker:up` for source builds. To run a published version,
follow [docs/DOCKER_IMAGES.md](docs/DOCKER_IMAGES.md) for registry login, image
pulls, updates, and rollback limitations. The first real registry publication
happens after merging Phase 6 and passing its publication checks.

## License

Proprietary — all rights reserved.
