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

**Module 3 test-run fixes.** The stocktake schedule fields were the last native date inputs; they
use a shared `DateTimeField` (the calendar plus a half-hour time list) now. A blind count no longer
shows on-hand quantities in the add-lines picker. Modal buttons keep their width while loading and
hold the spinner back for 180ms, so a refusal that opens a prompt no longer flashes on its way
past. Page-header actions use `ActionButton` everywhere and take the full width on a phone, so a
pair is the same size. The self-approval setting's description is two lines.

## Module 4 — approvals that carry their evidence

Module 3's test run showed that two approval flows stop short: the approver is told *that*
something needs them, but not *what*, and the stocktake's last steps say nothing about what they
do. Both are finished here, before new ground.

- **4a · Held deliveries.** A receiver stopped by an over-delivery or a price above the order
  saves the delivery as *awaiting approval* instead of losing it. The notification and the order
  open on that delivery — the quantities and prices the receiver typed beside what was ordered —
  and the approver accepts, edits or rejects it in one step. Purchasing lists deliveries awaiting
  approval as their own tile. Nothing touches stock or the supplier ledger until it is accepted.
- **4b · Stocktake workflow, end to end.** Decide and enforce who does each step: counters count;
  a reviewer (who did not count, unless their role may self-approve) explains each variance with a
  reason and a resolution, or sends lines back for recount; an approver signs off. Approving posts
  the adjustments and completes the count in one step — today *Post adjustments* and *Complete*
  are separate buttons that say nothing about what they do — and the result shows what changed:
  which batches moved, by how much, at what value.
- **4c · Phones, second pass.** Stat tiles two per row, and the remaining rough edges from walking
  each Operations page at 375px.

## Module 5 — POS refunds & customer returns

- **Customer returns move into POS**, with a restock-or-quarantine choice for what comes back.
- **Delete the Returns page.** Once customer returns live in POS, `/returns` goes: supplier
  returns are already under Purchasing, and two doors into the same list is the confusion the
  test run found.
- **Supplier → PO → GRN lineage on a return.** Choosing a supplier should narrow the purchase
  order list to that supplier's orders, and the delivery list to that order's deliveries, so a
  return can be traced back to what arrived instead of being typed from scratch.

## Module 6 — Inventory screens, adjustments and the supplier workspace

- **The supplier detail window needs its own pass.** Long price lists and invoice lists need
  paging, the sections want sub-tabs rather than one long scroll, and the save/close buttons
  currently stack awkwardly.
- **Dark-mode contrast.** Pale green surfaces with white text are hard to read in places, mostly
  action buttons.
- **The Invoices tab flickers** briefly when opened — a flash before the page paints, with no
  error behind it.
- **The stock adjustment form gets a redesign.** It works, but it is the oldest form in the area
  and reads like it: simplify it, fix its rough edges, and bring it in line with the receive form.

## Known gaps carried from Module 2

These are deliberate limits of what shipped, not defects:

- **Advance and unallocated supplier payments are not supported.** Every payment must be
  allocated in full to invoices, so money paid on account ahead of an invoice has nowhere to go.
  Needs a supplier credit balance that later invoices draw down. *Module 6 or its own module.*
- **Reorder suggestions use each product's reorder level, not sales velocity.** A seasonal or
  accelerating line is not noticed until it hits the level. *Wherever demand forecasting lands.*
- **The invoice list is one row per invoice**, so an invoice covering three deliveries has to be
  opened to see them. Fine today; revisit if invoices routinely span many deliveries.
- **Free and damaged units are counted beside received units, not inside them.** Receiving 10 with
  1 free and 2 damaged means 13 units arrived. This is deliberate — the three numbers answer
  different questions (what was billed, what was a bonus, what is claimable) — but the receiving
  form says so on screen (Module 3).
- **Applied debit notes do not appear under Payments**, and an applied debit note cannot be
  voided. Both are deliberate: a credit is not a payment, and unwinding an applied credit would
  restate a settled invoice. Revisit only if a supplier's credit is regularly cancelled.
