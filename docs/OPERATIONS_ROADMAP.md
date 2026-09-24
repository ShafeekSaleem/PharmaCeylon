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

## Module 3 — Transfers & Stocktakes

Both already sit on the Module 1 stock writer and approval rules, so this is workflow and screens.

- **Approve buttons everywhere else.** Transfers and returns now disable Approve with the reason
  on it when the viewer raised the document and their role cannot self-approve. Purchase orders
  and stocktakes still fail after the click — same treatment needed, using `canSelfApprove` from
  `GET /tenant/my-permissions`.
- **Escalation instead of a dead end.** A clerk stopped by an over-delivery or a price variance
  can only fetch someone. They should be able to send the decision to an approver — a "notify a
  manager" option on the refusal, landing in that person's notifications.
- **A shared, themed date picker.** Every from/to filter currently falls back to the browser's
  native calendar, which ignores the app's theme. One shared component, used by every date filter
  (Purchasing, Inventory, Reports, Transfers, Stocktakes).
- **Horizontal scrolling at phone width.** Several screens scroll sideways; a pass across the
  Operations pages with the 400px rule applied.

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
