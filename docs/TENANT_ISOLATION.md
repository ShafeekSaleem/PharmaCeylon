# Tenant and branch isolation

PharmaCeylon uses a shared PostgreSQL schema. Except for the tenant row itself
and the global permission catalog, domain records are tenant-owned through
`tenantId`. Operational records may also be branch-owned through `branchId`.

## Trust boundaries

- `tenantId` comes only from the authenticated `UserContext`.
- Clients must never select or submit a tenant id.
- `x-branch-id` is accepted only after `TenantBranchGuard` verifies that the
  authenticated user has a role on that branch.
- Branch-owned controller actions must resolve the branch through
  `@RequireBranchId()`.
- API permission checks authorize an action; they do not scope Prisma queries.

## Scope classes

| Scope | Examples | Required database filter |
|---|---|---|
| Global | `Permission` | Explicitly documented global query |
| Tenant | Product, Supplier, Customer, Role | `tenantId` |
| Branch | Sale, Batch, PurchaseOrder, Stocktake | `tenantId + branchId` |
| Multi-branch | Transfer | `tenantId`, then validate both branch ids |
| Tenant-wide analytics | Owner reports | `tenantId`; branch omission must be explicit |

## Query rules

Every read of a tenant-owned resource must include its scope:

```ts
await prisma.product.findFirst({
  where: { id: productId, tenantId },
});
```

A workflow pre-read does not replace scope on the final mutation. Prefer
`updateMany` or `deleteMany` with the id and full scope, then require exactly
one affected row:

```ts
const mutation = await prisma.purchaseOrder.updateMany({
  where: { id, tenantId, branchId },
  data: { status: PoStatus.issued },
});
assertOneScopedMutation(mutation, "Purchase order");
```

Child ids supplied by a client must be validated in the same tenant before they
are connected. For branch-owned children such as batches, validate the branch
as well.

## Automated mutation enforcement

`npm run check:tenant-scope --workspace=apps/api` derives the tenant-owned
Prisma delegates from `prisma/schema.prisma` and scans non-test API source.
Every `update`, `updateMany`, `delete`, and `deleteMany` on those delegates
must include `tenantId` in its final `where` object.

The check runs as part of the API lint task. It intentionally does not infer
scope from a pre-read: the final write must defend itself.

Two narrow exception labels are supported and require an inline reason:

- `tenant-scope: system-auth` for authentication lifecycle writes whose input
  is a verified, globally unique user/session identity rather than a
  tenant-selected resource id.
- `tenant-scope: verified-parent` when a lower-level helper receives only an id
  after its caller has already verified the tenant-owned parent.

Exceptions are review points, not general suppressions. Prefer passing
`tenantId` into the function and scoping the mutation whenever practical.

## Review checklist

For every endpoint or background job:

1. Is its scope global, tenant, branch, multi-branch, or explicitly tenant-wide?
2. Is `tenantId` derived from trusted server context?
3. Does every read include the required scope?
4. Does the final update/delete independently include the required scope?
5. Are related ids validated in the same tenant/branch?
6. Can a list, export, report, or aggregate include another tenant's rows?
7. Is there a regression test that inspects the Prisma `where` clause?
8. Does a zero-row mutation fail without an audit or stock/money side effect?

## Defence in depth roadmap

- [x] Scope high-risk product, supplier, held-sale, and purchasing mutations.
- [x] Scope remaining tenant-owned service mutations or document the narrow
  authentication lifecycle exception.
- [x] Enforce tenant scope on Prisma mutations during CI.
- [ ] Expand two-tenant integration coverage for branch workflows and reports.
- [ ] Introduce a request-aware tenant data-access layer.
- [ ] Prototype PostgreSQL row-level security after connection-pool and
  transaction semantics are proven; see `RLS_PROTOTYPE_PLAN.md`.
