# Role-Based Access Matrix

This document defines which pages each role can access in PharmaCeylon.

## Roles

| Role | Description |
|---|---|
| `owner` | Tenant owner. Full system access including billing and tenant config. |
| `manager` | Branch/operations manager. Near-full access except tenant-level settings. |
| `pharmacist` | Licensed pharmacist. Handles dispensing, POS, supplier and stock workflows. |
| `cashier` | Front-desk cashier. Processes sales and can browse products. |
| `inventory_clerk` | Stock management staff. Manages inventory, purchasing, transfers, and products. |

Tenants may also create **custom roles** (see `docs/API_CONTRACT.md` and the Users & Roles → Roles & Permissions page) with any subset of the permission catalog. Custom roles use the `custom` sentinel in `RoleName` and resolve their access from a per-tenant `Role`/`RolePermission` grant, not from this static matrix.

## Page Access Matrix

| Page | Route | owner | manager | pharmacist | cashier | inventory_clerk |
|---|---|---|---|---|---|---|
| Dashboard | `/dashboard` | yes | yes | yes | yes | yes |
| POS / Checkout | `/pos` | yes | yes | yes | yes | — |
| Products | `/products` | yes | yes | — | view | yes |
| Search Catalog | `/catalog` | yes | yes | yes | yes | yes |
| Suppliers | `/suppliers` | yes | yes | yes | — | yes |
| Inventory | `/inventory` | yes | yes | yes | — | yes |
| Purchasing | `/purchasing` | yes | yes | yes | — | yes |
| Transfers | `/transfers` | yes | yes | yes | — | yes |
| Reports | `/reports` | yes | yes | — | — | — |
| Analytics | `/analytics` | yes | yes | — | — | — |
| Audit Log | `/audit` | yes | yes | — | — | — |
| Users & Roles | `/users` | yes | yes* | — | — | — |
| Settings | `/settings` | yes | yes* | — | — | — |

> **yes*** = access with limitations (e.g. manager cannot escalate roles to owner, cannot modify tenant-level settings).
>
> **view** = page is visible (nav shown) but write operations (create/edit/delete) are restricted at the page and API level.

## Role Groups (code constants)

These are the named groups used in `app-shell.tsx` for nav-level visibility:

| Constant | Roles | Used by |
|---|---|---|
| `ADMIN_ROLES` | owner, manager | Audit Log, Users & Roles, Settings |
| `POS_ROLES` | owner, manager, pharmacist, cashier | POS / Checkout |
| `CATALOG_ROLES` | owner, manager, cashier, inventory_clerk | Products |
| `OPERATIONS_ROLES` | owner, manager, pharmacist, inventory_clerk | Suppliers, Inventory, Purchasing, Transfers |
| `INSIGHTS_ROLES` | owner, manager | Reports, Analytics |

Pages without a `roles` restriction (Dashboard, Search Catalog) are visible to all authenticated users.

## Enforcement Layers

Access is enforced at three levels:

1. **Nav visibility (frontend)** — The sidebar hides pages the user cannot access. This is a UX convenience, not a security boundary.

2. **Page-level guards (frontend)** — Individual pages should check roles before rendering write actions (create/edit/delete buttons). Read-only users see data but cannot modify it.

3. **API guards (backend)** — NestJS `@RequirePermission(...)` decorator + `RolesGuard` on each endpoint, resolved against the tenant's configurable `Role`/`RolePermission` grants (see `apps/api/src/security/permission-catalog.ts`). This is the authoritative enforcement layer. Even if the frontend is bypassed, the API rejects unauthorized requests. The `owner` role's grants are hardcoded and non-editable, so a tenant can never lock out every owner.

## Design Decisions

- **Dashboard** is unrestricted because each role sees a tailored summary relevant to their function.
- **Search Catalog** is unrestricted because all staff may need to look up drug information (interactions, alternatives, availability).
- **POS** excludes `inventory_clerk` as they do not process customer sales.
- **Products** excludes `pharmacist` (they use Search Catalog for lookups). Cashiers get view-only access to verify product details during sales.
- **Insights** pages are restricted to owner and manager to protect sensitive financial data.
- **Admin** pages are limited to owner and manager to prevent privilege escalation.
- Owner/manager can grant any of the above to a custom role via Users & Roles → Roles & Permissions — this matrix describes the built-in defaults, not a hard ceiling.
