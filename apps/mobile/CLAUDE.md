# CLAUDE.md — apps/mobile

This file provides guidance to Claude Code when working in `apps/mobile`.

## Status

This is an early-stage Expo shell — currently just `App.tsx` rendering a placeholder screen ("Expo mobile shell (companion app)") plus config. There is no navigation, API client, or auth integration yet. Don't assume patterns from `apps/web` (route groups, role-access components, etc.) exist here — they don't; if you're asked to build out a mobile feature, you're likely starting from scratch and should look at `apps/web`'s auth/role-access approach and the API contract (`docs/API_CONTRACT.md`) as the reference, not existing mobile code.

## Commands

```bash
npm run dev            # expo start --offline
npm run dev:online       # expo start (online, e.g. for physical device via Expo Go/tunnel)
npm run android / ios
npm run build             # tsc --noEmit (no bundling — this is a typecheck, matching the api/web "lint = typecheck" pattern isn't used here, build IS the typecheck)
npm run lint                # no-op: "No linter configured for mobile yet"
```

After `npm install` at the repo root, run `npx expo install` inside `apps/mobile` to align native dependency versions with the installed Expo SDK (recommended per root README).

## Notes

- Imports shared types from `@pharmaceylon/shared` (see root CLAUDE.md — must be built first).
- Expo SDK 52 / React Native 0.76 / React 18.3 — pinned versions, check `expo install` compatibility before bumping any of `expo`/`react-native`/`react` individually.
- No test runner configured.
