# Tenant data access-path audit

This document records every database entry-point class that must remain safe as
row-level security expands beyond the Product, Batch, and Sale canary.

The machine-readable inventory is `apps/api/tenant-data-entrypoints.json`.
`npm run check:tenant-scope -w api` fails when a direct database client,
public controller, worker/queue decorator, Prisma raw-SQL path, or approved
entry disappears or is introduced without classification.

## Current access paths

| Path class | Current implementation | RLS decision |
|---|---|---|
| Authenticated HTTP domain requests | JWT/tenant/branch guards followed by the opt-in tenant transaction interceptor | Use the non-owner application role and transaction-local tenant/branch settings |
| Login and refresh | Public auth controller; globally unique email or hashed session token establishes identity before tenant context exists | Keep identity tables out of the first activation wave; approve a dedicated bootstrap design before their RLS is enabled |
| JWT user-context lookup | Verified JWT subject loads the user and role mappings before the request transaction opens | Same bootstrap decision as login/refresh |
| Health endpoints | Public and database-free | No tenant context required |
| NMRA import | Authenticated request service using the shared proxied PrismaService | Runs inside the request tenant transaction; no detached worker exists today |
| Seed programs | Direct Prisma clients launched explicitly | Migration-owner role only; never use the runtime application URL |
| RLS administration/tests | Separate `pg`/Prisma clients in acknowledgement-gated or self-cleaning scripts | Migration administrator or ephemeral CI database only |
| Scheduled jobs/queue workers | None implemented | Any future worker must be added to the inventory and open `TenantTransactionContext.run` per tenant/branch |
| Raw SQL | Tenant setting infrastructure, startup catalog validation, scoped PO lock, and ephemeral activation proof | Every path is inventoried; domain SQL must bind tenant and branch values |

## Read and aggregate review

The service layer consistently derives `tenantId` from trusted request context.
High-volume reports and analytics frequently construct reusable Prisma
`where` fragments and spread them into reads/aggregates. The existing
application filters remain mandatory even after RLS activation.

Static mutation enforcement remains deliberately stricter because a final
write can be verified locally. General read analysis cannot safely infer scope
through arbitrary helper objects, relation filters, and nested Prisma
expressions. For reads, the controls are:

1. trusted request context and explicit service filters;
2. reviewable entry-point inventory preventing new unclassified execution
   paths;
3. schema-derived PostgreSQL tenant policies on every tenant-owned table;
4. staged two-tenant integration tests before each activation wave.

## Schema-wide policy inventory

All 42 Prisma models containing `tenantId` now have a staged PostgreSQL policy
with both tenant `USING` and `WITH CHECK` expressions.

- Product remains tenant-wide.
- Batch and Sale retain the branch-aware canary policy.
- Other branch-bearing tables initially receive tenant-only policies. Their
  application-level branch filters remain mandatory.
- No new table is ENABLE/FORCE RLS in the schema-wide staging migration.
- CI derives the expected table inventory from `schema.prisma`, validates the
  deployed policy expressions, and fails if a tenant-owned model has no policy.

## Activation waves

| Wave | Tables/domains | Gate |
|---|---|---|
| 0 | Product, Batch, Sale | Existing canary runbook and representative staging soak |
| 1 | Catalog metadata, stock ledger and inventory children | Product search, import, stock and expiry query-plan review |
| 2 | Purchasing, receipts, sales children, returns, transfers and stocktakes | End-to-end money/stock workflow and rollback tests |
| 3 | Customer, prescription, supplier, analytics targets, audit and idempotency | Reporting/export and retention validation |
| 4 | AppUser, Session, roles and branch-role mappings | Approved authentication-bootstrap design; login/refresh must work without bypassing tenant isolation |

Each wave must be activated using the non-owner application role, observed in
staging, and reversible independently. Do not combine the identity wave with
the first production canary.

## Remaining environment gates

Repository controls cannot replace environment evidence. Before production:

- provision separate migration and application roles in staging;
- execute the Wave 0 runbook and representative multi-tenant soak;
- record p95/p99 latency, pool saturation, lock waits and long transactions;
- exercise imports and every stock/money workflow;
- test backup/restore and the audited break-glass procedure;
- approve branch semantics and query plans for each later wave;
- rehearse enablement and rollback on a production-like copy.
