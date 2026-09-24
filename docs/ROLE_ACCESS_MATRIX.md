# Role-Based Access Matrix

This document defines which pages each role can access in PharmaCeylon.

## Roles

| Role              | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `owner`           | Tenant owner. Full system access including billing and tenant config.           |
| `manager`         | Branch/operations manager. Near-full access except tenant-level settings.       |
| `pharmacist`      | Licensed pharmacist. Handles dispensing, POS, supplier and stock workflows.     |
| `cashier`         | Front-desk cashier. Processes sales and can browse products.                    |
| `inventory_clerk` | Stock management staff. Manages inventory, purchasing, transfers, and products. |

Tenants may also create **custom roles** (see `docs/API_CONTRACT.md` and the Users & Roles → Roles & Permissions page) with any subset of the permission catalog. Custom roles use the `custom` sentinel in `RoleName` and resolve their access from a per-tenant `Role`/`RolePermission` grant, not from this static matrix.

## Page Access Matrix

| Page               | Route              | owner | manager | pharmacist | cashier | inventory_clerk |
| ------------------ | ------------------ | ----- | ------- | ---------- | ------- | --------------- |
| Dashboard          | `/dashboard`       | yes   | yes     | yes        | yes     | yes             |
| POS / Checkout     | `/pos`             | yes   | yes     | yes        | yes     | —               |
| Products           | `/products`        | yes   | yes     | view       | view    | yes             |
| Catalog management | `/products/manage` | yes   | yes     | view       | view    | yes             |
| Suppliers          | `/suppliers`       | yes   | yes     | yes        | —       | yes             |
| Inventory          | `/inventory`       | yes   | yes     | yes        | —       | yes             |
| Purchasing         | `/purchasing`      | yes   | yes     | yes        | —       | yes             |
| Transfers          | `/transfers`       | yes   | yes     | yes        | —       | yes             |
| Reports            | `/reports`         | yes   | yes     | —          | —       | —               |
| Audit Log          | `/audit`           | yes   | yes     | —          | —       | —               |
| Users & Roles      | `/users`           | yes   | yes\*   | —          | —       | —               |
| Settings           | `/settings`        | yes   | yes\*   | —          | —       | —               |

> **yes\*** = access with limitations (e.g. manager cannot escalate roles to owner, cannot modify tenant-level settings).
>
> **view** = page is visible (nav shown) but write operations (create/edit/delete) are restricted at the page and API level.

## Inventory actions (built-in defaults)

The Inventory page is visible to every role holding `inventory.view` (all five built-in roles). What each can *do* there:

| Action | Permission | owner | manager | pharmacist | cashier | inventory_clerk |
| --- | --- | --- | --- | --- | --- | --- |
| See stock, batches, movements | `inventory.view` | yes | yes | yes | yes | yes |
| See batch cost and stock value | `inventory.view_cost` | yes | yes | — | — | — |
| Add stock / confirm imported expiry | `inventory.manage` | yes | yes | — | — | yes |
| Write off stock (any decrease) | `inventory.write_off` | yes | yes | — | — | — |
| Quarantine units | `inventory.quarantine` | yes | yes | yes | — | yes |
| Release from quarantine | `inventory.release_quarantine` | yes | yes | yes | — | — |
| Quarantine all expired stock | `inventory.manage_bulk` | yes | yes | — | — | — |

- **Cost is withheld by the API, not only hidden.** Cashiers and pharmacists see selling prices but not cost or stock valuation. Purchasing has its own cost key, `purchasing.view_cost` (below).
- **Releasing is a quality decision**, so it sits with pharmacists and managers rather than the clerk who may have held the stock. Expired stock can't be released at all.
- **Write-offs moved from a hardcoded owner/manager check to `inventory.write_off`**, so a tenant can grant it to a custom role. The migration gave the new quarantine and release grants to any custom role that already had `inventory.manage`, so nobody lost an ability they had.

## Purchasing actions (built-in defaults)

| Action | Permission | owner | manager | pharmacist | cashier | inventory_clerk |
| --- | --- | --- | --- | --- | --- | --- |
| See orders and deliveries | `purchasing.view` | yes | yes | yes | — | yes |
| See unit costs and order values | `purchasing.view_cost` | yes | yes | yes | — | yes |
| Raise, edit and issue orders | `purchasing.manage` | yes | yes | — | — | yes |
| Book a delivery in | `purchasing.receive` | yes | yes | — | — | yes |
| Approve, reject, short-close, cancel | `purchasing.approve` | yes | yes | — | — | — |
| Accept an over-delivery | `purchasing.approve` | yes | yes | — | — | — |
| Accept a price above the order | `purchasing.approve` | yes | yes | — | — | — |
| See and change a supplier price list | `suppliers.manage_prices` | yes | yes | — | — | — |
| Record supplier invoices, raise / void debit notes | `purchasing.invoice` | yes | yes | — | — | — |
| Record and void supplier payments, apply debit notes | `suppliers.pay` | yes | yes | — | — | — |

- **Receiving split away from managing orders**, so a storekeeper can book deliveries in without being able to raise or price one. The migration granted `purchasing.receive` to every role that already had `purchasing.manage`, so nobody lost an ability.
- **Costs are a separate key now.** The defaults match what every role could already see (anyone with `purchasing.view`), but an owner can now take costs away from a role — which was impossible before. Withholding happens in the API: `unitCost`, `packCost`, order values and delivery values come back `null`.
- **Money is separate from stock.** Recording what a supplier billed and what was paid moved out of `suppliers.manage` (which the clerk holds) into `purchasing.invoice` and `suppliers.pay`. The clerk who books a delivery in never sees payables; the Invoices tab only appears for someone holding either key. Custom roles that already had `suppliers.manage` kept both.
- **Agreeing what a supplier charges is its own permission.** `suppliers.manage` (which the inventory clerk holds) covers the supplier record; the price list — reading it included — needs `suppliers.manage_prices`, granted to owners and managers. A clerk raising an order still gets lines priced from the list; they just cannot change what the pharmacy has agreed to pay. Custom roles that already held `suppliers.manage` keep the new key, because that was a deliberate choice someone made.

## Approving your own requests

Holding an approve permission (`purchasing.approve`, `transfers.approve`, `returns.approve`, `stocktakes.review`) lets someone approve *other people's* requests. Whether they may approve requests **they raised** is the tenant's choice in Settings → Approval Rules:

| Role | Default |
| --- | --- |
| Owner | may approve own |
| Manager | may approve own |
| Pharmacist, inventory clerk, cashier, custom roles | need a second approver |

A small pharmacy run by its owner is never blocked; a clerk's transfer, return or stocktake count still gets a second pair of eyes. Owners can switch any role on or off, including custom roles.

## Role Groups (code constants)

These are the named groups used in `app-shell.tsx` for nav-level visibility:

| Constant           | Roles                                       | Used by                                     |
| ------------------ | ------------------------------------------- | ------------------------------------------- |
| `ADMIN_ROLES`      | owner, manager                              | Audit Log, Users & Roles, Settings          |
| `POS_ROLES`        | owner, manager, pharmacist, cashier         | POS / Checkout                              |
| `CATALOG_ROLES`    | owner, manager, cashier, inventory_clerk    | Products                                    |
| `OPERATIONS_ROLES` | owner, manager, pharmacist, inventory_clerk | Suppliers, Inventory, Purchasing, Transfers |
| `INSIGHTS_ROLES`   | owner, manager                              | Reports                                     |

Pages without a `roles` restriction (Dashboard) are visible to all authenticated users.

## Enforcement Layers

Access is enforced at three levels:

1. **Nav visibility (frontend)** — The sidebar hides pages the user cannot access. This is a UX convenience, not a security boundary.

2. **Page-level guards (frontend)** — Individual pages should check roles before rendering write actions (create/edit/delete buttons). Read-only users see data but cannot modify it.

3. **API guards (backend)** — NestJS `@RequirePermission(...)` decorator + `RolesGuard` on each endpoint, resolved against the tenant's configurable `Role`/`RolePermission` grants (see `apps/api/src/security/permission-catalog.ts`). This is the authoritative enforcement layer. Even if the frontend is bypassed, the API rejects unauthorized requests. The `owner` role's grants are hardcoded and non-editable, so a tenant can never lock out every owner.

## Design Decisions

- **Dashboard** is unrestricted because each role sees a tailored summary relevant to their function.
- **Products** is open to every role because all staff may need to look up drug information, which is what Search Catalog used to be for. Its Reference catalog tab absorbed that page (`/catalog` now redirects there), so the route guard admits `catalog.view` as well as `products.view` and the two tabs are gated separately — a tenant that granted one key and not the other keeps exactly the access it had. Write actions stay behind `products.manage`.
- **POS** excludes `inventory_clerk` as they do not process customer sales.
- **Catalog management** (`/products/manage`) holds the work queue, categories and tags. Reading it takes `products.view` and every action inside takes `products.manage` — the same pair the `/products/organize` and `/products/nmra-matches` screens it replaced required, so consolidating four screens into one changed no one's access. Both old routes redirect to the matching filter.
- **Reports** (the analytics/financial section labeled "Insights" in the nav group) is restricted to owner and manager to protect sensitive financial data.
- **AI Insights** (`/insights`) is a separate, unrestricted hub aggregating every role's own dashboard recommendations — every role sees their own relevant insights, reached via the "View all insights" link on their dashboard rather than a sidebar entry (same pattern as `/notifications`). Owner/manager additionally see insights sourced from the 6 report sections whose backend already computes them (stock movement, transfers, stocktakes, purchase summary, supplier spend, supplier performance); that report-sourced content is gated inline by the `reports.view` permission, not by a route-level restriction, so it simply doesn't fetch/render for the other three roles.
- **Admin** pages are limited to owner and manager to prevent privilege escalation.
- Owner/manager can grant any of the above to a custom role via Users & Roles → Roles & Permissions — this matrix describes the built-in defaults, not a hard ceiling.
