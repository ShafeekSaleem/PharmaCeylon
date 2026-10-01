# Operations rebuild — what is done and what each remaining phase owes

The Operations area (inventory, purchasing, suppliers, transfers, stocktakes, returns) is being
rebuilt one module at a time: review → design → approval → implementation → a manual test plan
the pharmacy owner runs before the next module starts. This file is the backlog that survives
between modules — every gap we knowingly left, and the phase that owes it.

## Done

**Module 1 — stock foundation.** One writer (`StockService`) with row locks, and four quantities
per batch (on hand, quarantined, reserved, available). Reservations stopped being ledger rows, so
promised stock no longer disappears off the shelf and stocktakes count what is really there.
Self-approval became a tenant setting read through `AccessService` rather than a hardcoded role
check.

**Module 2a — orders, packs and deliveries.** Buying in packs and selling in units
(`unitsPerPack`, snapshotted per order line), running received/free/rejected totals per line, and
four refusals that are questions rather than dead ends: over-delivery, price variance, cost
conflict, expiry conflict. Per-supplier price lists, and the `purchasing.receive` /
`purchasing.view_cost` / `suppliers.manage_prices` permissions.

**Module 2b — supplier money.** Placeholder invoices raised by each delivery and superseded by the
supplier's real invoice, invoices spanning several deliveries, a payment ledger where `paidAmount`
is derived from allocations, debit notes raised automatically by supplier returns, and the
three-way match (ordered vs received vs billed). Money has its own permissions,
`purchasing.invoice` and `suppliers.pay`.

**Cost permission (between modules).** `inventory.view_cost` and `purchasing.view_cost` became
one app-wide `costs.view`; raising an order needs it as well as `purchasing.manage`; a withheld
figure reads as a dash, never zero.

**Module 3 — approvals, escalation, dates and phones.**
- **Approve says why it is unavailable** on every document — purchase orders and stocktakes now
  carry `selfApprovalBlocked`, computed by the same rule `assertMayApprove` enforces, as transfers
  and returns already did.
- **Escalation instead of a dead end.** A receiver stopped by an over-delivery or a price above the
  order can *Ask an approver*: the people who hold `purchasing.approve` at that branch get a
  notification that opens the order. Repeats within ten minutes are not re-sent.
- **One themed calendar** (`DatePicker`) for every date in the app — filters through
  `DateRangeField`, forms through `FormField` and directly.
- **Phones.** Every `DataTable` reads as cards below 640px, so nothing scrolls sideways or is cut
  off; page headers wrap their actions under the description.
- **The receive form adds up** good, free and damaged units on screen.

## Still to do in Operations

- **Supplier → PO → GRN lineage on a supplier return**, and the supplier detail window rework —
  both below.
- **Holding a delivery for approval.** Escalation notifies the approver, but the receiver's typed
  delivery is not kept: the approver books it in themselves. Keeping a pending delivery for one-
  click approval is the natural next step if receivers find re-entry a burden.
- **Stat tiles stack one per row on a phone**, which makes the top of each page long. Two per row
  would read better; a small, shared change.

## Module 4 — POS refunds & customer returns

- **Customer returns move into POS**, with a restock-or-quarantine choice for what comes back.
- **Delete the Returns page.** Once customer returns live in POS, `/returns` goes: supplier
  returns are already under Purchasing, and two doors into the same list is the confusion the
  test run found.
- **Supplier → PO → GRN lineage on a return.** Choosing a supplier should narrow the purchase
  order list to that supplier's orders, and the delivery list to that order's deliveries, so a
  return can be traced back to what arrived instead of being typed from scratch.

## Module 5 — Inventory screens, adjustments and the supplier workspace

- **The supplier detail window needs its own pass.** Long price lists and invoice lists need
  paging, the sections want sub-tabs rather than one long scroll, and the save/close buttons
  currently stack awkwardly.
- **Dark-mode contrast.** Pale green surfaces with white text are hard to read in places, mostly
  action buttons.
- **The Invoices tab flickers** briefly when opened — a flash before the page paints, with no
  error behind it.

## Known gaps carried from Module 2

These are deliberate limits of what shipped, not defects:

- **Advance and unallocated supplier payments are not supported.** Every payment must be
  allocated in full to invoices, so money paid on account ahead of an invoice has nowhere to go.
  Needs a supplier credit balance that later invoices draw down. *Module 5 or its own module.*
- **Reorder suggestions use each product's reorder level, not sales velocity.** A seasonal or
  accelerating line is not noticed until it hits the level. *Wherever demand forecasting lands.*
- **The invoice list is one row per invoice**, so an invoice covering three deliveries has to be
  opened to see them. Fine today; revisit if invoices routinely span many deliveries.
- **Free and damaged units are counted beside received units, not inside them.** Receiving 10 with
  1 free and 2 damaged means 13 units arrived. This is deliberate — the three numbers answer
  different questions (what was billed, what was a bonus, what is claimable) — but the receiving
  form should say so on screen rather than leaving it to be inferred. *Module 3, with the
  receiving screens.*
- **Applied debit notes do not appear under Payments**, and an applied debit note cannot be
  voided. Both are deliberate: a credit is not a payment, and unwinding an applied credit would
  restate a settled invoice. Revisit only if a supplier's credit is regularly cancelled.
