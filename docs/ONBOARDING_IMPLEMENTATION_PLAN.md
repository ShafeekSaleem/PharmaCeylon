# First-user entry and onboarding implementation plan

Branch: `codex/onboarding-entry-flow`
Base: `develop` at `a7056d1e56681654282518ef3ec7c2928714ce29`

## Scope

This branch implements the PMS application entry, first-owner signup, pharmacy workspace
onboarding, and post-creation readiness journey.

The public marketing website is explicitly out of scope and will be implemented separately.

## Architecture decision

The current application deliberately uses a tenant-bound identity:

- `AppUser.tenantId` is required.
- `AppUser.email` is globally unique.
- access/refresh tokens and sessions carry one tenant context.
- existing admin, RBAC, audit, Settings, and branch-scoped services depend on that model.

For the first release, signup will therefore use a secure pre-tenant
`OwnerRegistration` record. The real `AppUser` is created only when the verified owner
submits the final workspace review. Tenant, first branch, owner user, RBAC rows, branch role,
tenant settings, and the initial audit event are created atomically.

This avoids fabricating empty tenants and avoids a broad identity migration. Cross-tenant
workspace membership remains a future platform change; pharmacy chains continue to use
branches inside one tenant.

## Phase 1 — Entry and verified owner registration (implemented)

- Refresh the existing sign-in screen and add a clear owner-registration entry.
- Add `/register` and `/verify-email` routes using existing design tokens.
- Add a pre-tenant `OwnerRegistration` model and migration.
- Add rate-limited register, resend-verification, verify, status, and cancel endpoints.
- Send a six-digit email code so verification finishes in the browser where signup began.
- Hash passwords immediately; never store raw passwords or raw verification codes.
- Issue a short-lived, httpOnly onboarding cookie only after email verification.
- Keep public-route middleware explicit and narrow.
- Add API tests for duplicate email handling, token expiry, resend invalidation, and
  production-safe response shapes.

Exit criteria: a new owner can register, verify in the same browser, and hold a secure
pre-tenant onboarding session without creating a tenant or `AppUser`.

## Phase 2 — Resumable workspace draft (implemented)

- Add authenticated onboarding-session guard/decorator separate from normal tenant JWT auth.
- Add status and draft endpoints for the four wizard steps.
- Persist only validated draft fields; derive the current step on the server.
- Add the shared wizard shell and routes:
  - `/onboarding/pharmacy`
  - `/onboarding/branch`
  - `/onboarding/preferences`
  - `/onboarding/review`
- Reuse the same validation and field semantics as Tenant Profile, Branches, and Settings.
- Show persistent journey progress, live save state, contextual branch/receipt previews, and
  proper selectors for country, currency, time zone, phone code, province, and district.

Implementation note: the four routes share one wizard component and persist a validated JSON
draft on `OwnerRegistration`. The server derives the resume path from `currentStep`; the
onboarding cookie is verified by a dedicated guard before every draft read or write.

Exit criteria: verified owners can resume safely on another browser session and cannot access
normal tenant APIs.

## Phase 3 — Atomic pharmacy workspace provisioning

- Validate the entire draft again on the server.
- Generate collision-safe tenant and branch codes.
- In one database transaction create:
  - tenant and tenant defaults
  - first branch
  - built-in tenant RBAC roles and permissions
  - owner `AppUser`
  - owner branch role linked to the locked owner role
  - tenant settings
  - onboarding completion/audit records
- Make final submission idempotent.
- Exchange the onboarding cookie for the existing access, refresh, and CSRF cookies.
- Clear or mark the registration completed without retaining reusable secrets.

Exit criteria: retries never create duplicate workspaces and the owner lands in the created
tenant with valid owner access.

## Phase 4 — Get-started readiness journey

- Add `/get-started` inside the normal application shell.
- Derive task completion from real backend state.
- Track separately:
  - business and branch details
  - product setup
  - opening inventory
  - sales settings
  - checkout preparation
- Keep team invitation and branding optional.
- Add operation-specific server enforcement instead of one global UI-only go-live switch.

Exit criteria: the owner can explore the app, while incomplete operational prerequisites are
clear and enforced by the appropriate APIs.

## Phase 5 — Staff invitations

- Replace direct credential creation for new staff with expiring tenant invitations.
- Add invitation accept/create-account and existing-account paths within the current
  single-tenant identity constraint.
- Assign branch access and role only after successful acceptance.
- Invalidate user/permission caches on membership changes.
- Audit invitation creation, resend, revoke, expiry, and acceptance.

Exit criteria: invited staff bypass owner onboarding and enter only their assigned tenant and
branches.

## Phase 6 — Hardening and release readiness

- Accessibility and responsive checks for entry and wizard screens.
- API typecheck, tests, web lint/build, migration verification, and CI.
- Abuse controls, token cleanup, audit review, and email-delivery observability.
- End-to-end scenarios: interrupted signup, duplicate submit, expired verification, revoked
  invitation, provisioning retry, unauthorized tenant access, and owner re-login.
- Update local-development and deployment documentation.

## Deferred

- Public marketing website and its routes.
- Pricing, subscriptions, trials, and billing.
- Provider-managed approval UI unless enabled for the pilot.
- One global account with memberships across unrelated tenants.
- Mobile/offline onboarding.
