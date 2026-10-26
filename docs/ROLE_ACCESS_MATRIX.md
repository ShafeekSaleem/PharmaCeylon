# Role-Based Access Matrix

This document defines which pages each role can access in PharmaCeylon. The tables describe the
web app as it behaves today; [After desktop POS](#after-desktop-pos-target-decided-2026-10-27)
describes the decided target once a branch moves checkout to PharmaCeylon POS.

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

## After desktop POS (target, decided 2026-10-27)

Decided in [POS_V1_REVIEW.md](POS_V1_REVIEW.md) (D10, D-W1, D-W4); page-by-page detail in
[WEB_BACKOFFICE_TARGET.md](WEB_BACKOFFICE_TARGET.md). Nothing below is implemented yet. Each
change applies to a branch once its "desktop POS live" switch is on.

| Page | Route | Change from today | Who, by default |
| --- | --- | --- | --- |
| POS / Checkout | `/pos` | Removed. Checkout, held carts, refunds and prescription capture move to PharmaCeylon POS | Everyone who has `sales.pos_use` today uses the desktop instead |
| Sales (new) | `/sales` | Sales history, sale detail and receipt copies; remote refund authorization | Reading: `sales.view` (owner, manager, pharmacist, inventory clerk). Authorizing refunds: a new remote-refund permission |
| Counters (new) | Settings → Counters | Registers, enrollment, revoke, retire, offline-counter readiness | `tenant.management` (owner, manager), the key the terminal registry already checks. Offline-device assignment: owner, or a manager the owner delegated (D13) |
| Every page except the user's own account | — | Cashier-only users see only My Profile, Password & Security and personal display settings, and land on a "Use PharmaCeylon POS" page (D-W4) | Built-in cashier, and any custom role without back-office access |
| Operations pages | `/inventory`, `/purchasing`, `/suppliers`, `/transfers`, `/stocktakes` | Same people keep access. Physical steps (receive, dispatch, count, adjust, write off, quarantine, cash payout) become handoffs to the counter | Unchanged |

Cashier-only access is web scoping, not authorization. The cashier keeps its API permissions
(`products.view`, `customers.view`, `prescriptions.view`, `inventory.view`, `sales.view`,
`sales.refund` and others) because the desktop POS uses the same keys. Back-office access is a
role setting, not a `RoleName` check, so custom roles can be given it or not.

Roles & Permissions groups the catalog three ways:

| Group | What it covers | Keys |
| --- | --- | --- |
| Manage from anywhere | Viewing, editing, approving and administration from the web, mobile or a remote desktop session | Today's view, manage, approve, invoice and pay keys |
| At the counter | Physical effects that work only from an enrolled, locally used desktop, owners included | Today's `sales.pos_use`, `sales.refund`, `purchasing.receive`, `inventory.*` stock keys and similar; their names stay, their physical effects need a counter |
| Offline capabilities | What a prepared person may do on the offline counter | New: offline-device assignment (owner, delegable), local activation, business-hours acknowledgement, assisted shift handover |

New keys are added to `apps/api/src/security/permission-catalog.ts` by the epic that introduces
each endpoint (P1, P2, P4, P5 or W3). Planned: back-office web access (D-W4), terminal management,
offline assignment and activation, the two offline capabilities, discrepancy review and remote
refund authorization. Exact names are chosen when they are added.

## Inventory actions (built-in defaults)

The Inventory page is visible to every role holding `inventory.view` (all five built-in roles). What each can *do* there:

| Action | Permission | owner | manager | pharmacist | cashier | inventory_clerk |
| --- | --- | --- | --- | --- | --- | --- |
| See stock, batches, movements | `inventory.view` | yes | yes | yes | yes | yes |
| See batch cost and stock value | `costs.view` | yes | yes | yes | — | yes |
| Add stock / confirm imported expiry | `inventory.manage` | yes | yes | — | — | yes |
| Write off stock (any decrease) | `inventory.write_off` | yes | yes | — | — | — |
| Quarantine units | `inventory.quarantine` | yes | yes | yes | — | yes |
| Release from quarantine | `inventory.release_quarantine` | yes | yes | yes | — | — |
| Quarantine all expired stock | `inventory.manage_bulk` | yes | yes | — | — | — |

- **Cost is one permission for the whole app.** `costs.view` governs every figure that says what something cost or what it earns — batch costs and stock valuation, unit costs and order values, supplier prices on an order line, stocktake variance values, and any margin derived from them. It replaced the per-module `inventory.view_cost` and `purchasing.view_cost`, which answered the same question differently depending on the screen you were standing on. The API withholds the value (`null`); pages show a dash, never a zero.
- **Releasing is a quality decision**, so it sits with pharmacists and managers rather than the clerk who may have held the stock. Expired stock can't be released at all.
- **Write-offs moved from a hardcoded owner/manager check to `inventory.write_off`**, so a tenant can grant it to a custom role. The migration gave the new quarantine and release grants to any custom role that already had `inventory.manage`, so nobody lost an ability they had.

## Purchasing actions (built-in defaults)

| Action | Permission | owner | manager | pharmacist | cashier | inventory_clerk |
| --- | --- | --- | --- | --- | --- | --- |
| See orders and deliveries | `purchasing.view` | yes | yes | yes | — | yes |
| See unit costs and order values | `costs.view` | yes | yes | yes | — | yes |
| Raise, edit and issue orders | `purchasing.manage` **and** `costs.view` | yes | yes | — | — | yes |
| Book a delivery in | `purchasing.receive` | yes | yes | — | — | yes |
| Approve, reject, short-close, cancel | `purchasing.approve` | yes | yes | — | — | — |
| Accept an over-delivery | `purchasing.approve` | yes | yes | — | — | — |
| Accept a price above the order | `purchasing.approve` | yes | yes | — | — | — |
| See and change a supplier price list | `suppliers.manage_prices` | yes | yes | — | — | — |
| Record supplier invoices, raise / void debit notes | `purchasing.invoice` | yes | yes | — | — | — |
| Record and void supplier payments, apply debit notes | `suppliers.pay` | yes | yes | — | — | — |

- **Raising an order needs the cost permission too.** An order is a promise to pay a price, so `purchasing.manage` alone is not enough — a role that cannot see costs cannot commit the pharmacy's money. The API refuses, and the New purchase order button is disabled with the reason on it.
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

Target: nav gates on permissions (`usePermissions()`) rather than these role groups, and
`POS_ROLES` leaves the nav when the web POS is removed (W1, W2).

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
- **Owners can't skip the counter.** After desktop POS, physical stock, branch cash, refund execution and dispensing need an enrolled, locally used desktop for every role, owners included (revised D10). The owner shortcut in `RolesGuard` covers permissions, not that local-execution check.
- Owner/manager can grant any of the above to a custom role via Users & Roles → Roles & Permissions — this matrix describes the built-in defaults, not a hard ceiling.
