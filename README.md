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

Run PostgreSQL and the compiled API in Docker while keeping Next.js on the host:

```bash
docker compose --env-file .env.docker up -d --build api
npm run dev -w web
```

Stop the host-running API before publishing container port `3001`. See
**[docs/DOCKER.md](docs/DOCKER.md)** for the Phase 2 image walkthrough.

## License

Proprietary — all rights reserved.
