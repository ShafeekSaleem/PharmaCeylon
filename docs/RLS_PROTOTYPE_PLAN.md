# PostgreSQL RLS prototype plan

This is the next defence-in-depth phase after application-level mutation
scoping. It is deliberately a separate PR because enabling row-level security
changes database runtime behaviour for every request, migration, seed, worker,
and support script.

## Goal

Prove that PostgreSQL can reject cross-tenant reads and writes even when an
application query accidentally omits `tenantId`, without leaking request
context through the connection pool or breaking tenant-wide workflows.

The prototype is not production-ready until every exit gate below passes.

## Phase 3 foundation status

Implemented in this phase:

- `TenantTransactionContext` owns an interactive Prisma transaction, sets
  `app.tenant_id` and `app.branch_id` with transaction-local
  `set_config(..., true)`, and exposes the same transaction client through
  `AsyncLocalStorage`.
- Nested work may reuse the context only when tenant and branch match; attempting
  to switch either scope fails before another query is issued.
- `npm run test:rls-poc --workspace=apps/api` creates an ephemeral
  non-superuser/`NOBYPASSRLS` role and RLS-protected table in PostgreSQL,
  verifies tenant A/B read isolation and `WITH CHECK` write rejection, then
  proves both settings are cleared when the same pooled connection is reused.
- The proof runs in CI and removes its temporary schema and role in a
  `finally` block.

Not enabled in this phase:

- no production table has RLS enabled;
- no HTTP interceptor automatically opens tenant transactions;
- existing services have not yet been switched from the root
  `PrismaService` to `TenantTransactionContext.client`.

Those constraints are intentional. Enabling policies before every query path
uses the transaction-aware client would cause partial or misleading isolation.

## Phase 4 canary status

Implemented in this phase:

- `PrismaService` is wrapped by a transaction-aware proxy. During an active
  tenant context, existing delegate calls and nested `$transaction` calls use
  the same interactive transaction client and pooled connection.
- An authenticated-request interceptor can open the context after JWT, CSRF,
  tenant/branch, and role guards have succeeded.
- The interceptor is opt-in through
  `TENANT_TRANSACTION_CONTEXT_ENABLED=true`; the default remains `false`.
- Inert `USING` and `WITH CHECK` policies are staged for the mapped
  `product`, `batch`, and `sale` tables.
- CI now deploys the complete migration history and verifies those policies
  exist while `relrowsecurity` and `relforcerowsecurity` remain disabled.

Activation requirements:

1. Provision a separate non-owner, `NOBYPASSRLS` application database role.
2. Enable the request transaction flag in a non-production environment.
3. Exercise product, inventory/batch, checkout/sale, reports, NMRA import, and
   background paths under realistic load.
4. Only then enable and force RLS for the canary tables in a separate migration.

## Phase 5 staging activation status

Implemented in this phase:

- a guarded role-preparation command validates an existing application login as
  `NOSUPERUSER NOBYPASSRLS`, confirms it owns no application tables, and
  grants runtime privileges without transferring ownership;
- guarded status/enable/disable commands manage only the three canary tables,
  require an explicit acknowledgement for changes, and validate the
  non-bypassing application role before activation;
- application startup fails closed when `RLS_CANARY_ENFORCED=true` unless the
  request transaction boundary is enabled, the runtime role cannot bypass RLS
  or own a canary table, and all three tables have ENABLE/FORCE RLS;
- CI temporarily enables RLS on the real Product, Batch, and Sale tables,
  connects through an ephemeral non-owner role, and proves missing-scope,
  tenant, branch, read, create, update, and delete behaviour through Prisma;
- the live proof includes a scoped-transaction latency smoke threshold and
  always restores the table flags, fixtures, and role;
- `docs/RLS_CANARY_RUNBOOK.md` defines the staging sequence, validation window,
  rollback order, and remaining production approval boundary.

Still not enabled by repository migration:

- no checked-in migration automatically enables RLS;
- production activation is not approved;
- non-HTTP paths and representative staging load still require an environment
  soak before the canary can advance.

## Architecture decision

Use transaction-local PostgreSQL settings:

- `app.tenant_id` — required for tenant-owned application queries.
- `app.branch_id` — optional; introduced only after tenant RLS is stable.

Set them with `set_config(..., true)` or `SET LOCAL` inside an interactive
transaction. Transaction-local state is automatically cleared at transaction
end, which prevents one pooled connection from retaining another request's
tenant.

Every tenant-aware HTTP request must therefore execute its Prisma operations
through one request transaction. An `AsyncLocalStorage` context can expose
that transaction client to services without changing every controller
signature at once.

## Database roles

Use separate database principals:

| Principal | Purpose | RLS behaviour |
|---|---|---|
| Migration owner | Prisma migrations and controlled maintenance | Owns tables; never used by the running API |
| Application role | API requests and workers | No `BYPASSRLS`; subject to policies |
| Break-glass support | Time-limited audited investigation | Explicit operational procedure; not configured in the app |

Policies should use both `USING` and `WITH CHECK`. Production tables should
use `FORCE ROW LEVEL SECURITY` after migration/seed behaviour is verified.

## Prototype sequence

1. **Completed:** add a transaction/context abstraction without enabling
   production policies; nested calls share one Prisma transaction client.
2. **Completed:** run a real PostgreSQL proof with two tenants and verify
   transaction-local settings disappear when the pool reuses its connection.
3. **Completed:** route existing Prisma access through the active request
   transaction and stage disabled policies for `Product`, `Batch`, and
   `Sale`.
4. **Completed in CI:** validate a non-owner application role, temporarily
   ENABLE/FORCE the real canary tables, and test direct reads, aggregates,
   creates, updates, deletes, missing-scope behaviour, branch behaviour, and a
   transaction latency smoke threshold.
5. **Next in staging:** activate the transaction boundary and canary policies
   with the runbook, then soak product, inventory, checkout, reporting, NMRA
   import, and worker paths under representative traffic.
6. Verify every non-HTTP path: authentication, seed, NMRA import, scheduled
   jobs, migrations, and support scripts.
7. Expand policy generation to all tenant-owned models and compare the policy
   inventory against `schema.prisma` in CI.
8. Roll out in observe/test environments first, then stage, then production
   behind an explicit deployment checklist.

## Policy shape

The tenant portion of each policy should be equivalent to:

```sql
USING (
  "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
  "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
)
```

The exact cast must match the deployed column type. A missing setting must
return no tenant rows and reject writes, not fall back to unrestricted access.

Branch RLS should not be added until tenant-wide owner/reporting operations
have an explicit branch-set strategy. Application-level `tenantId + branchId`
filters remain mandatory regardless of RLS.

## Exit gates

- Cross-tenant read and write attempts fail at the database layer.
- Pool-reuse tests show no tenant or branch context leakage.
- The application principal cannot bypass or disable RLS.
- Login/refresh and other pre-request-context authentication paths are
  explicitly handled.
- Imports, jobs, migrations, seeds, and support scripts use documented roles and
  context.
- Query plans for high-volume product search, checkout, inventory, reports, and
  analytics remain acceptable with tenant-leading indexes.
- Backup/restore and break-glass procedures are tested and audited.
- The application-level CI mutation guard and regression tests remain enabled.

## Non-goals

RLS does not replace authorization, branch-role validation, DTO validation,
audit logging, or explicit Prisma scoping. It is the last containment layer
when one of those controls is missed.
