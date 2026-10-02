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

## Module 4 — approvals that carry their evidence, and one door for returns

The old Modules 4 and 5, combined (approved 3 October 2026, design as recommended). Module 3's
test run showed two approval flows that stop short — the approver is told *that* something needs
them but not *what*, and the stocktake's last steps say nothing about what they do — and customer
returns had two doors with a gap in each.

- **4a · Held deliveries.** *(Done — kept as its own `HeldDelivery` record rather than a status on
  `GoodsReceipt`, so no delivery query has to skip unposted rows.)* A receiver stopped by an over-delivery or a price above the order
  saves the delivery as *awaiting approval* instead of losing it. The notification and the order
  open on that delivery — what arrived and was billed beside what was ordered — and the approver
  accepts, **corrects then accepts**, or rejects it with a reason. Nothing touches stock or the
  supplier ledger until it is accepted.
- **4b · Stocktake, end to end.** *(Done.)* Count → review → approve, one owner per step. The
  reviewer is also the approver, and may not have counted unless their role may approve its own
  requests — checked when review starts, not only at approval. A variance needs a **reason**
  (the typed resolution is gone; a note is optional). **Approve adjusts stock to the count,
  quarantines units counted as damaged, expired or temperature-affected, and completes the
  stocktake** in one transaction, after a confirmation that says what will change; the stocktake
  then shows *What changed*. Stocktakes approved before this keep a one-time *Post adjustments*.
- **4c · Customer returns live in POS.** *(Done. Customer returns left open on the old Returns
  page are listed in POS to be cancelled and refunded at the till; the demo seed no longer
  creates open ones.)* Refund lines choose *back on the shelf* or *hold for
  inspection*; controlled and prescription items default to hold. Refunds over the tenant's
  threshold are approved at the till with an approver's PIN. `sales.refund` replaces the
  hardcoded refund roles. `/returns` redirects to supplier returns; POS lists recent refunds.
- **4d · Supplier returns traced to the delivery.** Choosing a delivery fills the return lines;
  a delivery with damaged units held against it offers *Return to supplier*; a batch can't be
  returned against a delivery beyond what that delivery brought in.
- **4e · Phones, second pass.** Stat tiles two per row, and a walk of every Operations page at
  375px, including the new screens.

## Module 5 — Inventory screens, adjustments and the supplier workspace

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
  Needs a supplier credit balance that later invoices draw down. *Module 5 or its own module.*
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
