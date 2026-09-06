# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

npm-workspaces monorepo managed with Turborepo:

```
apps/
  api/       NestJS + Prisma + PostgreSQL (+ Redis) — REST API, port 3001
  web/       Next.js App Router — port 3000
  mobile/    Expo (React Native) — early-stage shell, not built out yet
packages/
  shared/    @pharmaceylon/shared — types/constants shared by api/web/mobile
docs/        API_CONTRACT.md, LOCAL_DEV.md, ROLE_ACCESS_MATRIX.md
```

Each app/package has its own `CLAUDE.md` with package-specific detail — read it when working inside that package. This file covers cross-cutting architecture and root-level commands.

## Commands (from repo root)

```bash
npm install              # also runs `prepare`, which builds @pharmaceylon/shared
npm run dev               # turbo: runs api + web dev servers together
npm run build              # turbo: builds all workspaces
npm run lint                # turbo: lints all workspaces
npm run test                 # turbo: api (jest) + web (jest/jsdom) suites
npm run format               # prettier --write across the repo
```

Per-workspace (`-w <name>`, names are `api`, `web`, `mobile`, `@pharmaceylon/shared`):

```bash
npm run dev -w api          # Nest only, :3001 — does NOT start web
npm run dev -w web           # Next only, :3000
npm run lint -w api           # tsc --noEmit (api has no eslint script; lint = typecheck)
npm run test -w api            # jest, all *.spec.ts
npm run test -w web             # jest + testing-library, all *.spec.tsx
npm run prisma:migrate -w api   # prisma migrate dev
npm run prisma:seed -w api       # seed demo tenant/users/data
```

Run a single API test: `npm run test -w api -- src/sales/pos.service.spec.ts` (or `cd apps/api && npx jest <path>`). Tests are colocated as `*.spec.ts` next to the source they cover.

**Windows:** web is pinned to Next 15.3.2 because newer 15.4.x+ patch releases fail `next build` on Windows (prerendering `/404`). Don't bump Next without checking that issue is fixed, or build on Linux/WSL/CI instead.

## Architecture

### Three-tier auth/tenant/branch model

Every API request that isn't `@Public()` passes through four global guards, in this order: `JwtAuthGuard` → `CsrfGuard` → `TenantBranchGuard` → `RolesGuard` (registered in `apps/api/src/app.module.ts`). Understanding this pipeline is required before touching any endpoint:

1. **`JwtAuthGuard`** — validates the access token (cookie or Bearer), attaches `request.user` (a `UserContext`: userId, tenantId, email, `tokenVersion`, and `branchRoles: {branchId, role, roleId}[]`).
2. **`CsrfGuard`** — double-submit check, only enforced when `request.user.authMethod === "cookie"` (browser flow) and the method is unsafe (not GET/HEAD/OPTIONS). Bearer-token clients (mobile) skip this — no cookie means no CSRF exposure.
3. **`TenantBranchGuard`** — reads the `x-branch-id` header, verifies the user has a role on that branch, sets `request.branchId`. No header ⇒ passes through with no branch scoping (endpoint decides what that means).
4. **`RolesGuard`** — reads `@RequirePermission(...)` metadata; `owner` on _any_ branch always passes (hardcoded, non-configurable); otherwise resolves the caller's tenant-configurable permission grants **on `request.branchId`** (or across all their branches if no branch header was sent) via `PermissionsService`.

`AppUser.email` is globally unique — login resolves `tenantId` from the user row, not from a header/subdomain. Tenant isolation itself is enforced by services scoping every Prisma query with `tenantId` (there's no Postgres RLS) — when adding a query, always filter by tenant/branch explicitly, don't rely on the guards for data scoping beyond authn/authz.

`UserContextService` (`apps/api/src/auth/user-context.service.ts`) caches the per-user role/branch lookup in-process for `USER_CONTEXT_TTL_SECONDS` (default 30s) to avoid a DB join on every request. It's invalidated explicitly whenever `tokenVersion` bumps (role change, password change, logout-all). If you change how roles/branches are assigned, make sure the code path calls `invalidate(userId)`.

### Configurable roles & permissions

Built-in roles (`RoleName` enum, mirrored in `apps/web/src/lib/role-access.ts`): `owner`, `manager`, `pharmacist`, `cashier`, `inventory_clerk`, plus a `custom` sentinel for tenant-defined roles. What each role can actually do is **not** hardcoded per-endpoint — every endpoint declares a permission key via `@RequirePermission("module.action")` (`apps/api/src/security/decorators/require-permission.decorator.ts`), and `apps/api/src/security/permission-catalog.ts` is the single source of truth for the full permission catalog plus each built-in role's default grants (seeded per-tenant as `Role`/`RolePermission` rows by `apps/api/prisma/rbac-seed.ts`). Owner/manager can toggle any role's permissions, or create custom roles, from Users & Roles → Roles & Permissions (`PATCH/POST /admin/roles`) — **except** the `owner` role itself, whose grants are hardcoded and non-editable (`Role.isLocked`), so a tenant can never lock every owner out. `PermissionsService` resolves a `UserBranchRole`'s effective permissions from its `roleId` (falling back to the static catalog defaults if `roleId` is unset), with an in-process cache invalidated on edit — mirrors `UserContextService`'s pattern.

Full page/role matrix and the reasoning behind the built-in defaults: `docs/ROLE_ACCESS_MATRIX.md`. The frontend nav/page guards are UX only (checked against `GET /tenant/my-permissions`) — **the API's `RolesGuard` is the authoritative enforcement layer**, so any new endpoint needs its own `@RequirePermission(...)` (add the key to the catalog if it's new), don't rely on the web app hiding the button.

### Web ↔ API wiring (dev)

The browser always calls the **same origin as Next** (`NEXT_PUBLIC_API_BASE_URL`, default `http://localhost:3000/api/v1`) so auth cookies work without cross-origin cookie handling. Next rewrites `/api/v1/*` and `/uploads/*` to `API_PROXY_TARGET` (default `http://127.0.0.1:3001`, i.e. the Nest process) — see `apps/web/next.config.ts`. Nest itself always listens on :3001. After login the web app sends `x-branch-id` on requests once a branch is selected; that header is what `TenantBranchGuard`/`RolesGuard` scope against.

### Range status: what the pharmacy actually sells

`Product.isActive` used to answer three unrelated questions at once, so the NMRA importer's
"this registration is valid" overwrote the pharmacy's own "we stopped selling this", and a
15,000-row registry import landed in the product list. Three fields now, each with one owner:

- **`rangeStatus`** (`REFERENCE` | `RANGED`) — does this pharmacy sell it? Imports write
  `REFERENCE`; the shop promotes to `RANGED` explicitly, or automatically the first time stock
  arrives (`products/product-range.util.ts` — call `ensureProductsRanged` from any new path
  that creates stock).
- **`isActive`** — is this record enabled? **Pharmacist-owned; importers must never write it.**
  A `RANGED` product that is inactive is a discontinued line.
- **`nmraRegistrationValid`** — is the NMRA registration current? Import-owned, `source = NMRA`
  only.

Read-side default: the Products page, transaction pickers and the global search bar show
`RANGED` only; the Reference catalog tab shows the register.

Leaving the range is **not** a free toggle — see `products/range-transition.util.ts`. Only a
register-derived product with no stock and no history may go back to `REFERENCE`; anything the
shop created itself is deactivated instead, because the reference catalog _is_ the NMRA
register and local records don't belong in it. Nothing holding stock moves at all.

### Catalog Management (`/products/manage`)

Products has two tabs — My products and Reference catalog. Everything else about the catalog
lives in one workspace with three in-place sections: Work Queue, Categories, Tags. The four
screens it replaced (`/products/categories`, `/products/tags`, `/products/organize`,
`/products/nmra-matches`) all redirect to the matching section or filter, as does `/catalog`,
whose search folded into the Reference tab.

`CatalogTask` is the durable spine. Missing categories and register matches used to be
recomputed on every page load, so a decision could not be _recorded_ — dismissing an umbrella
from the medicines queue hid it until the next refresh. Tasks now have a lifecycle (`OPEN`,
`NEEDS_REVIEW`, `RESOLVED`, `DISMISSED`, `NOT_APPLICABLE`), and `CatalogTaskService.refresh` is
idempotent and never overwrites a terminal row — safe to run after every import and whenever
the queue is opened.

Three rules the matching side depends on, all in `apps/api/src`:

- **`catalog/nmra-eligibility.ts`** decides what belongs in the register queue at all. Checks
  regulatory signals first, retail keywords _second_, and weak medicine signals last — the order
  matters, because "Deodorant Spray 150ml" has a dosed strength and "Hand Sanitizer Gel" has a
  dosage form. Only a `regulatory`-tier product earns a "nothing matched" task.
- **`products/reference-candidates.ts`** finds candidates with bounded, indexed probes driven by
  the product's own identifiers. It replaced a `take: 5000` scan that silently made two thirds
  of a 15,000-row register unmatchable, with _which_ two thirds depending on row order.
- **`catalog-tasks/catalog-task-safety.ts`** defines what "Apply safe changes" may touch.
  Compliance changes and ambiguous identifiers are excluded however strong the evidence.

Applying an NMRA task goes through `ProductNmraLinkService.link` — there is one implementation
of the field-ownership policy, not a second one in the queue.

### Idempotency (money/stock mutations)

Money- and stock-mutating endpoints (POS checkout, goods receipt, transfer ship/receive) accept an optional `Idempotency-Key` header, scoped per `tenantId + userId + operation`. First request performs the mutation and records key → resource id; retries with the same key replay the same result; reusing a key for a _different_ logical operation is a 400. See `apps/api/src/common/idempotency.util.ts` and `docs/API_CONTRACT.md` for the exact scope table. Any new endpoint that mutates money or stock should follow this pattern, not invent a new one.

### Domain modules (`apps/api/src/*`)

Business logic is organized as one Nest module per domain: `sales` (POS/checkout/held-sales/pharmacist-approval/refunds), `products`, `product-import` (a pharmacy's own product list + opening stock, uploaded and column-mapped), `catalog`, `catalog-tasks` (the Catalog Management work queue), `inventory`, `pricing` (VAT), `purchasing`, `returns`, `transfers`, `stocktakes`, `suppliers`, `customers` (+ prescriptions), `nmra` (Sri Lanka National Medicines Regulatory Authority catalog import/normalize), plus platform modules `auth`, `security` (guards/decorators), `tenant`, `admin`, `audit`, `analytics`, `reports`, `uploads`. Controlled products (`Product.isControlled`) require pharmacist/manager/owner at checkout — see `sales/pharmacist-approval.service.ts` and `sales.checkout-controlled.spec.ts`.

Pricing/VAT is Sri Lanka–oriented but configurable via `PRICING_VAT_RATE_PERCENT`; a checkout line either sends its own `taxAmount` or the server computes VAT exclusive on `(unitPrice × qty − discountAmount)`.

The Prisma schema (`apps/api/prisma/schema.prisma`, ~40 models) is the source of truth for the domain shape — read it before assuming a relation exists.

### Shared package

`packages/shared` currently only exports a couple of constants/types (`APP_NAME`, `HealthStatus`). It must be built (`npm run build -w @pharmaceylon/shared`, or the root `prepare` script) before api/web/mobile can resolve `@pharmaceylon/shared` — if you add something there and the consuming app doesn't see it, rebuild the package first.

## Docs worth reading before larger changes

- `docs/API_CONTRACT.md` — auth flow, branch header, idempotency scopes, sales lifecycle, versioning.
- `docs/ROLE_ACCESS_MATRIX.md` — role → page/route matrix and the design rationale behind each restriction.
- `docs/LOCAL_DEV.md` — env var setup, seed users, CORS, default ports/URLs.
