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

1. Add a request transaction/context abstraction without enabling policies.
   Verify nested service calls share one Prisma transaction client.
2. Add integration tests that repeatedly alternate two tenants through a pool
   and prove the tenant setting is absent after each transaction.
3. Enable RLS on three canary tables representing different shapes:
   `Product` (tenant-wide), `Batch` (tenant + branch), and `Sale`
   (transactional aggregate).
4. Test direct reads, aggregates, creates, updates, deletes, nested writes,
   interactive transactions, and deliberate missing-scope queries.
5. Verify non-HTTP paths: authentication, seed, NMRA import, scheduled jobs,
   migrations, and support scripts.
6. Expand policy generation to all tenant-owned models and compare the policy
   inventory against `schema.prisma` in CI.
7. Roll out in observe/test environments first, then stage, then production
   behind an explicit deployment checklist.

## Policy shape

The tenant portion of each policy should be equivalent to:

```sql
USING (
  "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
)
WITH CHECK (
  "tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid
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
