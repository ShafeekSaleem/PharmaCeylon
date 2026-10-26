# Web back office — target state after desktop POS

Decided by Shafeek on 2026-10-27: web decisions D-W1–D-W7, recorded in
[POS_V1_REVIEW.md](POS_V1_REVIEW.md). This document translates the POS v1 contract into what each
web page keeps, what moves to the enrolled desktop counter, and what the web shows instead. The
normative rules stay in [POS_V1_CONTRACT.md](POS_V1_CONTRACT.md) (revised D10) and
[POS_OPERATIONAL_MUTATIONS.md](POS_OPERATIONAL_MUTATIONS.md). Nothing here is implemented yet;
the web epics W1–W10 below deliver it.

## Principles

- **Manage from anywhere, execute at the counter.** Planning, editing, approving and
  administration stay on the web. Checkout, refund execution, physical stock changes, counts,
  branch cash and clinical dispensing happen in PharmaCeylon POS on an enrolled desktop (D10).
- **Branch by branch.** Each branch has a "desktop POS live" switch (D-W1, D-W7). Until it is on,
  that branch's web pages behave as they do today.
- **Never remove a web action before the counter can do it.** A workflow's execute button goes
  only when its backend split (P1 or P6) and its desktop screen (P6) exist for that branch.
- **The API decides.** Hiding a button is UX. `RolesGuard` and P1/P6 enforcement are the
  boundary, and every new endpoint still needs `@RequirePermission(...)`.
- **The web never claims counter evidence.** It never sends terminal, attendance or offline
  evidence, and a browser request is never treated as local execution.
- **Approvals show their evidence.** Wherever a document is approved, show its approved version,
  its status and the requester, approver and executor separately.

## The rollout switch (D-W1, D-W7)

- One boolean per `Branch`, built in W1. Owners change it; every change is audited. It is
  returned with the branch in `/tenant/context` so nav and pages can read it without another call.
- When on, the web hides POS navigation, the Quick Sale button, the global search POS action and
  every deep link into `/pos`, and replaces execute buttons with counter handoffs.
- P1's denial of browser checkout for that branch flips at the same time. If enforcement came
  first, the branch could not sell.
- P7's tenant/branch rollout controls reuse this switch. It controls rollout only; it never grants
  authority or bypasses an API check.

## Page by page

| Page | Route | Stays on the web | Moves to the counter | Web shows instead | Epic |
| --- | --- | --- | --- | --- | --- |
| POS / Checkout | `/pos` | Nothing, once the branch is live | Checkout, held carts, receipts, refunds, prescription capture and co-sign, PIN setup | "Checkout has moved to PharmaCeylon POS" with download and enrollment links | W2 |
| Sales (new) | `/sales` | Sales history, sale detail, receipt copy, remote refund authorization, refund approvals, incident and payment-recovery queues | Refund execution, goods inspection and disposition | "Approved — waiting at the counter" on authorized refunds | W4 |
| Customers | `/customers` | Customer records and contact details | — | — | — |
| Prescriptions | `/prescriptions` | Dispensing register (read), customer contact | Capture, clinical verification, co-sign, dispensing | Read-only register | W5 |
| Products and catalog | `/products`, `/products/manage` | Catalog, prices, NMRA linking, categories, tags, catalog-only import | Posting an import's stock rows; undo that removes stock | Stock rows staged "to post at the counter" (D-W2) | W5 |
| Inventory | `/inventory/*` | Stock views, adjustment and write-off requests, approvals | Adjust, write off, quarantine and release, confirm expiry, quarantine expired stock | Handoff on approved requests; posted stock shown apart from offline sales still pending posting | W5 |
| Purchasing | `/purchasing/*` | Raise, edit, issue, approve, reject, short-close and cancel orders; held-delivery decisions; invoices; debit notes; bank, cheque and card payments with evidence | Receive goods; accept a held delivery into stock; cash payouts | "Receive at the counter" | W5 |
| Suppliers | `/suppliers` | Supplier records, price lists, ledger and evidenced payments | Cash payouts | — | W5 |
| Supplier returns | `/purchasing/supplier-returns` | Prepare, approve, credit | Goods leaving the branch | Handoff on approved returns | W5 |
| Transfers | `/transfers` | Request, approve, cancel, reservations | Dispatch at the source branch, receive at the destination | Handoff per branch | W5 |
| Stocktakes | `/stocktakes/*` | Plan, schedule, assign, add or remove lines, review, request recounts, approve | Start, count capture, submit, complete, post | Read-only count progress, also on phones (D-W3) | W5 |
| Stock discrepancy cases (new) | to be named | Review the batch timeline and count evidence, authorize corrections | Physical count and correction | Affected batch blocks | W5 |
| Counters (new) | Settings → Counters | Registers, enrollment codes, revoke, report lost, retire, offline-counter readiness, remote assignment authorization (D13), replacement clearance, installer download | Enrollment on the device, local activation (D13) | Status per counter | W6 |
| Users and roles | `/users` | Staff, roles, permission groups, delegation, manager capabilities, PIN status and reset, force logout including counter sessions | PIN setup (D-W5) | PIN and preparation status per person | W3 |
| Settings | `/settings/*` | Structured branch hours (D-W6), counters and receipts, payments including the offline card toggle, offline policy, approval rules, notifications | — | "Applies to counters after their next sync" | W7 |
| Onboarding and get-started | `/onboarding/*`, `/get-started` | Business and branch details with structured hours, products, staged opening stock | Enroll the first counter; confirm and post opening stock (D-W2) | Checklist with the counter steps | W8 |
| Dashboard | `/dashboard` | Role dashboards, daily work, counter health, reconciliation | — | Each work item says whether it is done on the web or at the counter | W9 |
| Notifications and search | top bar | Alerts, including counter and sync alerts; sale lookup by invoice | — | — | W9 |
| Reports | `/reports` | Every report, with counter, shift and channel dimensions; shift cash, offline activity and discrepancy reports | — | Freshness banner while offline sales are pending sync | W10 |
| Audit log | `/audit` | Requester, approver and executor; terminal, shift and command | — | — | W10 |
| Sign-in and account | `/login`, `/settings/my-profile`, `/settings/password-login` | Sign-in, profile, password, sessions including counter sessions, desktop download link | — | Cashier-only landing page (D-W4) | W3 |

## Decision details for the web

### Cashier-only staff (D-W4)

- A user whose roles at the selected branch give no back-office access sees My Profile,
  Password & Security and personal display settings, and lands on a "Use PharmaCeylon POS" page.
- Decide this from a role setting, not from `RoleName`, so custom roles work. Built-in cashier
  defaults to no back-office access; every other built-in role defaults to having it.
- Do not remove the cashier's API permissions. The desktop uses the same keys (`products.view`,
  `customers.view`, `prescriptions.view`, `inventory.view`, `sales.view`, `sales.refund` and
  others). This is web scoping, not authorization.

### PINs (D-W5)

- One personal PIN per person, set or changed on the desktop while online. The server keeps its
  verifier for online co-sign and refund approval; each prepared terminal keeps its own.
- The web shows whether a PIN is set or locked, which terminals the person is prepared on and the
  credential version, and an admin can reset it. The web never sets a PIN.
- Today's copy that sends staff to "POS → Quick Actions" goes.

### Opening stock (D-W2)

- Onboarding stages opening stock on the web, from an import file or by entry, with no stock
  effect. Get-started then shows "Confirm opening stock at the counter", and the enrolled counter
  posts it. There is no exemption that lets the web post stock before go-live.

### Stocktake counting (D-W3)

- Counts are captured only in PharmaCeylon POS (laptop or tablet) in v1. The web count sheet,
  including its phone card layout, becomes a read-only progress view.
- Counting on an enrolled mobile device is a later epic.

### Branch hours (D-W6)

- Replace free-text `Branch.openingHours` with a weekly schedule, dated exceptions and holidays,
  mandatory restrictions and online business extensions, and migrate existing text.
- Keep D8's meaning: mandatory restrictions `null` means none, an empty list means no selling. P3
  signs these into grants; the web is their only editor.

## Copy patterns

| Situation | Web copy |
| --- | --- |
| An execute button is replaced at a live branch | "Do this at the counter in PharmaCeylon POS." |
| An approved document waits for execution | "Approved — waiting at the counter", with the branch and who can do it |
| A material edit after approval | "Changed since approval — needs fresh approval." |
| A note-only edit after approval | No warning; the approval stands |
| A setting that feeds grants or snapshots | "Applies to counters after their next sync." |

API refusals map to one message each:

| Stable code | When it happens | Web message |
| --- | --- | --- |
| `TERMINAL_REQUIRED` | A physical step was sent from the browser | "This is done at the counter. Open PharmaCeylon POS at the branch to finish it." |
| `REMOTE_SESSION_DENIED` | A remote desktop session tried a physical step | "This needs someone at the counter in person." |
| `APPROVAL_REQUIRED` | Execution without an approval | "This needs approval first." |
| `APPROVAL_INVALID` | The approval doesn't match this document or action | "This approval doesn't match the document. Ask for a new approval." |
| `APPROVAL_STALE` | Material content changed after approval | "This changed after it was approved. It needs fresh approval." |
| `SELF_APPROVAL_DENIED` | Approving your own request where the branch doesn't allow it | "You raised this, so someone else needs to approve it." |
| `PAYMENT_EVIDENCE_REQUIRED` | A bank, cheque or card payment without evidence | "Attach the payment evidence to record this payment." |
| `PHARMACIST_REQUIRED` | A clinical step without qualified evidence | "A pharmacist has to verify this at the counter." |

Never label stock as "offline reserved" or "guaranteed", and never show offline sales still
pending posting as posted stock.

## Web epics

| Epic | What it delivers | Phase |
| --- | --- | --- |
| W0 | These decisions, this document, the role matrix target and the GitHub epic edits below | A |
| W1 | Rollout switch, API-code handling, approval-evidence panel, counter-handoff state, permission-driven nav | A |
| W2 | Web POS sunset: link replacement, per-branch hiding, final code deletion | A, B, E |
| W3 | Users, roles, PIN status, delegation, sign-in and sessions, cashier-only landing | A–C |
| W4 | Sales page, receipt copies, remote refund authorization and recovery queues | A, B, D |
| W5 | Operations handoffs per workflow; stock discrepancy cases page | A–D |
| W6 | Counters and devices admin | B–D |
| W7 | Structured branch hours and the settings counters need | A–C |
| W8 | Onboarding and get-started for desktop POS; demo data | B |
| W9 | Dashboards, daily work and notifications | A, C–D |
| W10 | Reports and audit across counters, shifts and offline periods | B, D |

Phases follow the P-epic gates. A: start now. B: P1's boundary on and P2's online POS live at a
branch. C: P6 core workflows split and P3 grants ready. D: P5 sync and reconciliation accepted.
E: P7 pilot passed and every branch live.

## Ownership against P0–P7

The W-epics own web screens and the web-only backend behind them (for example the sales list
endpoint, the branch-hours model and the daily-work item targets). P0–P7 keep their API, desktop
and data work. Edits to make to the GitHub epic descriptions so no task is in two epics:

- P6 #52 item 3 (remote screens, approval status, desktop handoff): keep API splits and desktop
  execution screens; move the web screens to W1 and W5.
- P6 #52 item 6 and P2 #48 item 4 both list D13 assignment authorization: P2 owns the API and
  local activation, W6 owns the web authorization screen; drop it from P6 apart from acceptance.
- P6 #52 items 8 and 10 and readiness items 1 and 2: keep data and APIs; move their display to
  W3, W4, W5, W9 and W10.
- P2 #48 item 7: name W7 as the owner of the branch-hours model and editor (D-W6).
- P7 #53 item 11: reuse the W1 rollout switch (D-W7).

## Not changing

Catalog, pricing, suppliers, purchase orders, invoices, debit notes and customer records stay
managed on the web as today. Revised D10 permits remote management of all of them.
