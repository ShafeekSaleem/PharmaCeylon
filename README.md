# PharmaCeylon

Monorepo for the PharmaCeylon pharmacy management platform.

## Stack

- **API:** NestJS, Prisma, PostgreSQL, Redis (JWT access + refresh)
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
- PostgreSQL 16+ (local or managed)
- Redis 7+ (local or managed)

## Setup

1. Install dependencies from the repo root:

   ```bash
   npm install
   ```

   This runs `prepare`, which builds `@pharmaceylon/shared` once so Nest/Next can import it.

2. Copy environment examples and fill in values:

   - `apps/api/.env.example` → `apps/api/.env`
   - `apps/web/.env.example` → `apps/web/.env.local`

3. Run database migrations (from `apps/api`):

   ```bash
   cd apps/api
   npx prisma migrate dev --name init
   npx prisma generate
   ```

4. Align Expo native dependency versions (recommended after install):

   ```bash
   cd apps/mobile
   npx expo install
   ```

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

## License

Proprietary — all rights reserved.
