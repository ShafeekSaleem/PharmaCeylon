# CLAUDE.md — apps/api

This file provides guidance to Claude Code when working in `apps/api`. See the root `CLAUDE.md` first for the cross-cutting auth/tenant/branch model, idempotency pattern, and web↔API wiring — this file only covers API-specific detail.

## Commands

```bash
npm run start:dev          # nest start --watch, :3001
npm run lint                 # tsc -p tsconfig.json --noEmit (no eslint script — lint IS the typecheck)
npm run test                   # jest, all *.spec.ts
npm run test:watch
npm run test:cov
npx jest src/sales/pos.service.spec.ts     # single test file
npx jest -t "some test name"                # by test name

npm run prisma:generate
npm run prisma:migrate         # prisma migrate dev
npm run prisma:seed             # seeds demo tenant + users (see docs/LOCAL_DEV.md for creds)
npm run prisma:studio
```

Swagger UI: `http://localhost:3001/api/v1/docs` (disable with `OPENAPI_ENABLED=false`). Controllers are annotated incrementally — `sales` has the richest docs; extend decorators as other modules stabilize.

`.env` must be present (`cp .env.example .env`) before `nest start` or `prisma db seed` — `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` are required at minimum.

## Module layout

One directory per domain under `src/`, each with `*.module.ts` + `*.controller.ts` + `*.service.ts` + `dto/`. Tests are colocated `*.spec.ts` files, not a separate `__tests__` tree.

- **Commerce**: `sales` (POS checkout, held sales, pharmacist approval, void/refund), `products`, `catalog`, `inventory`, `pricing` (VAT), `purchasing`, `returns`, `transfers`, `stocktakes`, `suppliers`, `customers` (+ prescriptions)
- **Regulatory**: `nmra` — imports/normalizes the Sri Lanka National Medicines Regulatory Authority product catalog (`prisma/data/nmra-*`); see `nmra-import-merge.ts` / `nmra-normalize.ts` for the merge/normalize logic and their `.spec.ts` siblings for expected behavior on messy source data.
- **Platform**: `auth` (login, sessions, cookies, `UserContextService`), `security` (guards + decorators — the enforcement layer described in the root CLAUDE.md), `tenant`, `admin`, `audit`, `analytics`, `reports`, `uploads`, `prisma` (the `PrismaService` wrapper), `health`.

## Security building blocks (`src/security/`)

- `guards/`: `jwt-auth.guard.ts`, `csrf.guard.ts`, `tenant-branch.guard.ts`, `roles.guard.ts` — registered globally in `app.module.ts` in that order. Don't add a fifth ad-hoc guard on a single controller unless the ordering genuinely doesn't matter; prefer extending an existing one.
- `decorators/`: `@Public()` (`public.decorator.ts`) skips all four guards — used for `/auth/login`, `/health`, etc. `@RequirePermission(...)` (`require-permission.decorator.ts`) is read by `RolesGuard`, which resolves the caller's tenant-configurable `Role`/`RolePermission` grants (via `PermissionsService`) rather than a hardcoded role list — see `security/permission-catalog.ts` for the full permission catalog and each built-in role's default grants. The `owner` role's grants are hardcoded non-editable (`Role.isLocked`) so a tenant can never lock out every owner. `@RequireBranch()` and `@CurrentUser()` round out the set.
- `security.guards.spec.ts` covers the guard interaction directly — extend it rather than hand-rolling a new integration test when changing guard logic.

## Prisma

- `prisma/schema.prisma` — ~40 models, source of truth for the domain. Read it before assuming a relation/field exists rather than guessing from service code.
- `prisma.config.ts` loads `DATABASE_URL` via Nest `ConfigModule`; the Prisma client uses the `@prisma/adapter-pg` driver adapter (Prisma 7), not the default engine.
- `prisma/seed.ts` (+ `seed-helpers.ts`, `seed-demo-ops.ts`, `seed-nmra.ts`) builds a full demo tenant: users per role, products, suppliers, purchase orders, sales history, stocktakes. Read `seed-helpers.ts` for the date/decimal helpers it expects (`dateOnly`, `daysAgo`, `dec`, etc.) if you extend the seed.
- Migrations are timestamp-named directories under `prisma/migrations/`; never hand-edit an applied migration — add a new one.

## Conventions to follow

- **Tenant/branch scoping is manual.** There's no Postgres RLS — every service query must filter by `tenantId` (and `branchId` where relevant) itself. The guards only gate *access*, not *data scope*.
- **Idempotency** for money/stock-mutating endpoints uses `normalizeIdempotencyKey()` / the `IdempotencyRecord` model (see root CLAUDE.md) — follow the existing pattern in `sales.service.ts` / `purchasing.service.ts` / `transfers.service.ts` rather than inventing per-endpoint locking.
- **Controlled substances**: any new sales/dispense path touching `Product.isControlled` needs the same pharmacist/manager/owner check as `sales.checkout-controlled.spec.ts` exercises — don't bypass `pharmacist-approval.service.ts`.
- Role/branch changes must call `UserContextService.invalidate(userId)` (bumping `tokenVersion` is the usual trigger) or the 30s cache can serve stale roles.
