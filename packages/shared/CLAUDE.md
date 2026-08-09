# CLAUDE.md — packages/shared

This file provides guidance to Claude Code when working in `packages/shared`.

## What this is

`@pharmaceylon/shared` — currently a single file (`src/index.ts`) exporting a couple of cross-app constants/types (`APP_NAME`, `HealthStatus`). Consumed via `file:../../packages/shared` by `apps/api`, `apps/web`, and `apps/mobile`.

## Commands

```bash
npm run build -w @pharmaceylon/shared     # tsc -p tsconfig.json → dist/
npm run dev -w @pharmaceylon/shared         # tsc --watch, useful when iterating alongside a consumer's dev server
```

`main`/`types` in `package.json` point at `./dist/index.js` / `./dist/index.d.ts` — **consumers resolve the compiled output, not `src/`.** After editing this package, run the build (or the root `npm install`, which runs it via the `prepare` script) or api/web/mobile won't see the change. There's no watch-mode wired into the root `turbo run dev` for this package, so if you're actively iterating on shared code alongside another app, run `npm run dev -w @pharmaceylon/shared` in a second terminal.

No linter or test runner configured yet.

## Adding to this package

Keep it to genuinely cross-cutting types/constants/pure utilities needed by 2+ of api/web/mobile (e.g. `RoleName`, DTO shapes). Anything API-shape-specific that only the web app needs to mirror (like the role→route matrix in `apps/web/src/lib/role-access.ts`) has stayed app-local so far — don't move it here without a reason more than one consumer needs it.
