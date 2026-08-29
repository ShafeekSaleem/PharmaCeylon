# CLAUDE.md — apps/web

This file provides guidance to Claude Code when working in `apps/web`. See the root `CLAUDE.md` first for the auth/tenant/branch model and web↔API proxy wiring — this file only covers web-specific detail.

## Commands

```bash
npm run dev          # next dev --turbopack -p 3000 — requires the API running separately (root `npm run dev` starts both)
npm run build          # next build
npm run lint             # next lint
```

There is no test script in this package (no test runner configured yet) — verify changes by running the dev server and exercising the page in a browser, or via API-level tests in `apps/api`.

`.env` (or `.env.local`) needs `NEXT_PUBLIC_API_BASE_URL` and `API_PROXY_TARGET` — defaults in `.env.example` match the standard local ports and rarely need changing.

## Routing structure (App Router, `src/app/`)

- `(app)/` — authenticated app pages: `audit`, `catalog`, `dashboard`, `inventory`, `pos`, `products`, `purchasing`, `reports`, `returns`, `settings`, `stocktakes`, `suppliers`, `transfers`, `users`.
- `(shell)/` — `dashboard`, `login` (an alternate/legacy shell layout — check which one is live before adding a page in either group; don't assume both are maintained equally).
- `login/` (top-level) and `page.tsx` / `not-found.tsx` — entry/marketing-adjacent routes.
- `api/v1/` — Next Route Handlers that exist *in addition to* the `next.config.ts` rewrite (e.g. NMRA import confirm needs a 10-minute timeout the generic rewrite doesn't give it). Route Handlers here take precedence over the `/api/v1/:path*` rewrite to the Nest API — check here first if an API call isn't reaching Nest as expected.
- `middleware.ts` — gates every non-asset route behind the presence of the `pc_csrf` cookie (not a real auth check, just "is there a session cookie at all"); redirects to `/login?redirect=<path>` otherwise. Root `/` redirects to `/dashboard` or `/login` based on the same cookie.

## Auth & role access

- `lib/auth-client.ts`, `lib/auth-session.ts`, `lib/use-auth.ts`, `lib/use-require-auth.ts` — cookie-based session handling; the browser always talks to the same-origin `/api/v1/*` (proxied to Nest, see root CLAUDE.md) so cookies/CSRF work without cross-origin handling.
- `lib/role-access.ts` — the static, built-in-role-name based check (still used by most nav/button gates and by `rolesForPath()`, a route→roles table with longest-prefix match): owner-on-any-branch bypasses all checks, otherwise roles are scoped to the currently selected branch. `collectUserRoles(user, branchId)` derives the effective role set. This can't see custom-role grants (there's no static array for a tenant-defined role), so it's being superseded page-by-page by `lib/permissions.ts`'s `usePermissions()` (fetches `GET /tenant/my-permissions`, branch-scoped, refetches on branch change) — pass `permissions={["module.action"]}` to `RolePageGuard` for any route that must respect custom-role grants; the API's permission key catalog lives in `apps/api/src/security/permission-catalog.ts`. Either way this file is UX-only, the API is the real enforcement (see `docs/ROLE_ACCESS_MATRIX.md`).
- `components/role-access/` — `role-page-guard.tsx` (wraps a page and shows `role-access-denied.tsx` if the user lacks access; accepts `roles` and/or the permission-aware `permissions` prop above), `role-button.tsx` / `role-link.tsx` (disable/hide controls based on role, role-only for now). Prefer these over ad-hoc `if (role === ...)` checks in page components.

## Components

- `components/app-shell/` + `components/pms-nav.tsx` — the authenticated layout shell and nav; nav-level role filtering lives here and reads the same `role-access.ts` role groups (`ADMIN_ROLES`, `POS_ROLES`, `CATALOG_ROLES`, `OPERATIONS_ROLES`, `INSIGHTS_ROLES`, etc.) documented in `docs/ROLE_ACCESS_MATRIX.md`.
- `components/ui/` — shared primitives (`data-table`, `modal`, `form-field`, `stat-card`, `status-badge`, `page-header`, `image-upload`, `floating-tooltip`) with colocated `*.module.css`. Reuse these before writing new page-local styled components.
- Styling is CSS Modules throughout (no Tailwind/CSS-in-JS) — follow the `*.module.css` per-component pattern.

## Notes

- Next is pinned to **15.3.2** — see root CLAUDE.md for why (Windows `next build` prerender bug in later 15.4.x+ patches). Don't bump without checking upstream status.
- `eslint.ignoreDuringBuilds: true` in `next.config.ts` — monorepo hoisting breaks `eslint-config-next`'s parser resolution during `next build`. `next lint` still works standalone; CI/scripts should call it explicitly rather than relying on the build to lint.
- `transpilePackages: ["@pharmaceylon/shared"]` — if you change `packages/shared`, rebuild it (`npm run build -w @pharmaceylon/shared`) for the web app to pick up the change; Next transpiles the workspace source but still reads from `dist/`.
