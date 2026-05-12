# Local development (API + web)

This monorepo uses **npm workspaces**. From the repository root:

## Prerequisites

- Node.js 20+
- PostgreSQL reachable from your machine
- Optional: Redis (reserved for future features; not required for auth + web smoke tests)

## One-time setup

```bash
npm ci
npm run prepare
```

Copy environment files:

- **API:** `cp apps/api/.env.example apps/api/.env` and set `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`.
- **Web:** `cp apps/web/.env.example apps/web/.env` (or `.env.local`) and adjust `NEXT_PUBLIC_API_BASE_URL` / `API_PROXY_TARGET` only if your ports differ from the defaults below.

Apply schema and seed demo data (from repo root):

```bash
npm run prisma:migrate -w api
npm run prisma:seed -w api
```

> **Prisma 7:** the API loads `DATABASE_URL` via `apps/api/prisma.config.ts` and Nest `ConfigModule`. The Prisma client uses the PostgreSQL driver adapter; ensure `DATABASE_URL` is set before `prisma db seed` or `nest start`.

## Daily commands

**Important:** Starting `npm run dev` **inside `apps/api` only** runs Nest on **:3001**. It does **not** start Next.js, so **`http://localhost:3000` will not work** until you also run the web app.

| Goal | Command |
|------|---------|
| API + web together | From **repo root**: `npm run dev` (Turbo runs both `apps/api` and `apps/web`) |
| API only | `npm run dev -w api` |
| Web only | `npm run dev -w web` (use together with API, or use root `npm run dev`) |
| API typecheck | `npm run lint -w api` |
| API tests | `npm run test -w api` |
| Web lint | `npm run lint -w web` |

### Windows and `next build`

Some Next.js **15.4.5+** patch releases fail `next build` on **Windows** while prerendering internal `/404` (`useContext` null; see [vercel/next.js#82366](https://github.com/vercel/next.js/issues/82366)). The web app is pinned to **Next 15.3.2** so `next build` succeeds on Windows. That line may be behind security patches—**watch [Next.js security advisories](https://nextjs.org/blog)** and bump to the first release that fixes both the advisory and the Windows prerender bug (or build the web app on **Linux / CI / WSL** with a newer Next).

### Default URLs

| Service | URL |
|---------|-----|
| Web (Next.js) | http://localhost:3000 |
| API (Nest, direct — mobile/Postman) | http://localhost:3001/api/v1 |
| Browser API base (same origin as web) | http://localhost:3000/api/v1 (proxied to Nest) |

### Web → API wiring

- The browser calls **`NEXT_PUBLIC_API_BASE_URL`** on the **same host as Next** (default `http://localhost:3000/api/v1`). Next rewrites `/api/v1/*` to **`API_PROXY_TARGET`** (default `http://127.0.0.1:3001`), so auth cookies and CSRF work without cross-origin cookie reads.
- Nest still listens on **port 3001**; only the SPA uses the `:3000/api/v1` URL.
- After login, pick a **branch** in the dashboard; the app sends `x-branch-id` on authenticated requests so tenant/branch guards match the API.

### CORS

The API allows origins listed in `WEB_ORIGINS` (comma-separated). Use the **web app** origin (e.g. `http://localhost:3000`), not the API port. If you open the site from another device, add that origin too (e.g. `http://192.168.x.x:3000`).

### Optional: JSON HTTP logs (API)

Set `STRUCTURED_HTTP_LOG=true` in `apps/api/.env` to emit one JSON line per finished request on stdout (useful for local debugging; tune retention in production).

### Seed users (defaults)

See output of `npm run prisma:seed -w api`. Demo logins use **email + password** only (e.g. `admin@pharmaceylon.demo`); override passwords with `SEED_ADMIN_PASSWORD` / `SEED_CASHIER_PASSWORD` in `apps/api/.env` before seeding.
