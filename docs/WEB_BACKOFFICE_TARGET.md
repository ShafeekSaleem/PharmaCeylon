# Web back office — target state after desktop POS

Decided by Shafeek on 2026-10-27 and amended the same day: web decisions D-W1–D-W7, recorded in
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
  that branch's web pages behave as they do today. A branch goes live only after its go-live
  checklist passes, and an owner can fall back to the web POS for a while if its counters can't
  sell.
- **Never remove a web action before the counter can do it.** A workflow's execute button goes
  only when its backend split (P1 or P6) and its desktop screen (P6) exist for that branch.
- **The API decides.** Hiding a button is UX. `RolesGuard` and P1/P6 enforcement are the
  boundary, and every new endpoint still needs `@RequirePermission(...)`.
- **The web never claims counter evidence.** It never sends terminal, attendance or offline
  evidence, and a browser request is never treated as local execution.
- **Approvals show their evidence.** Wherever a document is approved, show its approved version,
  its status and the requester, approver and executor separately.

## The rollout switch and fallback (D-W1, D-W7)

- One per-branch state, built in W1: not live, live, or live with a fallback active. Only owners
  change it, and every change is audited. It is returned with the branch in `/tenant/context` so
  nav and pages can read it without another call.
- **Going live.** The switch can be turned on only after the branch's go-live checklist passes:
  at least one enrolled counter, staff prepared on it, and a printed test receipt.
- **When live,** the web hides POS navigation, the Quick Sale button, the global search POS action
  and every deep link into `/pos`, and replaces execute buttons with counter handoffs. P1's denial
  of browser checkout for that branch follows the same state, so a branch is never left unable to
  sell.
- **Fallback.** When a live branch's counters can't sell (for example its only desktop has
  failed), an owner starts a fallback and sets when it ends. While it is active, that branch's
  web POS page works as before desktop POS, online only, including refunds and prescription
  sales with the existing online pharmacist co-sign. Other operations pages keep their counter
  handoffs. A banner shows on every page for that branch, every sale is labelled a fallback sale,
  and the fallback ends automatically at the set time or when the owner ends it.
- **Deleting the web POS code** waits for a settling-in period after every branch is live; the P7
  pilot review sets its length.
- P7's tenant/branch rollout controls reuse this state. It decides where the counter-only rules
  apply and when a fallback is active. It gives no one extra permissions.

## Page by page

| Page | Route | Stays on the web | Moves to the counter | Web shows instead | Epic |
| --- | --- | --- | --- | --- | --- |
| POS / Checkout | `/pos` | Nothing once the branch is live, except during an owner fallback (D-W1) | Checkout, held carts, receipts, refunds, prescription capture and co-sign, PIN setup | "Checkout has moved to PharmaCeylon POS" with download and enrollment links | W2 |
| Sales (new) | `/sales` | Sales history, sale detail, receipt copy, remote refund authorization, refund approvals, incident and payment-recovery queues | Refund execution, goods inspection and disposition | "Approved — waiting at the counter" on authorized refunds | W4 |
| Customers | `/customers` | Customer records and contact details | — | — | — |
| Prescriptions | `/prescriptions` | Dispensing register (read), customer contact | Capture, clinical verification, co-sign, dispensing | Read-only register | W5 |
| Products and catalog | `/products`, `/products/manage` | Catalog, prices, NMRA linking, categories, tags, catalog-only import | Posting an import's stock rows; undo that removes stock | Stock rows staged "to post at the counter" (D-W2) | W5 |
| Inventory | `/inventory/*` | Stock views, adjustment and write-off requests, approvals | Adjust, write off, quarantine and release, confirm expiry, quarantine expired stock | Handoff on approved requests; posted stock shown apart from offline sales still pending posting | W5 |
| Purchasing | `/purchasing/*` | Raise, edit, issue, approve, reject, short-close and cancel orders; held-delivery decisions; invoices; debit notes; bank, cheque and card payments with evidence | Receive goods; accept a held delivery into stock; cash payouts | "Receive at the counter" | W5 |
| Suppliers | `/suppliers` | Supplier records, price lists, ledger and evidenced payments | Cash payouts | — | W5 |
| Supplier returns | `/purchasing/supplier-returns` | Prepare, approve, credit | Goods leaving the branch | Handoff on approved returns | W5 |
| Transfers | `/transfers` | Request, approve, cancel, reservations | Dispatch at the source branch, receive at the destination | Handoff per branch | W5 |
| Stocktakes | `/stocktakes/*` | Plan, schedule, assign, add or remove lines, enter count lines on phones while a count is open, review, request recounts, approve, print count sheets | Start the count, submit, complete, post | Who entered each line and when (D-W3) | W5 |
| Stock discrepancy cases (new) | to be named | Review the batch timeline and count evidence, authorize corrections | Physical count and correction | Affected batch blocks | W5 |
| Counters (new) | Settings → Counters | Registers, enrollment codes, revoke, report lost, retire, offline-counter readiness, remote assignment authorization (D13), replacement clearance, installer download | Enrollment on the device, local activation (D13) | Status per counter | W6 |
| Users and roles | `/users` | Staff, roles, permission groups, delegation, manager capabilities, PIN status and reset, force logout including counter sessions | PIN setup and preparing each counter (D-W5) | PIN status and which counters each person is prepared on | W3 |
| Settings | `/settings/*` | Structured branch hours (D-W6), counters and receipts, payments including the offline card toggle, offline policy, approval rules, notifications | — | "Applies to counters after their next sync" | W7 |
| Onboarding and get-started | `/onboarding/*`, `/get-started` | Business and branch details with structured hours, products, staged opening stock (replaceable until posted) | Enroll the first counter; post opening stock in one action or by category (D-W2) | Checklist with the counter steps and a suggested first stocktake | W8 |
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
- No verifier is ever copied between devices, so each person prepares every counter they will use
  offline by signing in there once while online. A PIN change or reset needs those counters
  prepared again.
- The web shows whether a PIN is set or locked, which counters the person is prepared on and the
  credential version, and an admin can reset it. The web never sets a PIN.
- Staff screens and counter readiness warn when someone hasn't been prepared on a counter since
  their last PIN change.
- Today's copy that sends staff to "POS → Quick Actions" goes.

### Opening stock (D-W2)

- Applies at live branches; once desktop POS is generally available, new branches start live.
- Onboarding stages opening stock on the web, from an import file or by entry, with no stock
  effect. The owner can replace the draft until it is posted.
- Get-started then shows "Post opening stock at the counter". The counter posts it in one action or
  in chunks by category; nobody is asked to confirm thousands of rows one by one.
- Get-started suggests a first full stocktake a few weeks after go-live, which is where the shelf
  check really happens.

### Stocktake counting (D-W3)

- A count is started at the counter. While it is open, staff enter count lines on phones or the
  web, and each line records who entered it and when. The existing phone card layout stays.
- Blind counts still hide on-hand quantities, wherever lines are entered.
- Submit, complete and post stay at the counter. Printable count sheets are available for
  counting on paper.

### Branch hours (D-W6)

- Replace free-text `Branch.openingHours` with a weekly schedule, dated exceptions and holidays,
  mandatory restrictions and online business extensions, and migrate existing text.
- Keep D8's meaning: mandatory restrictions `null` means none, an empty list means no selling. P3
  signs these into grants; the web is their only editor.
- Safe defaults: no mandatory restriction unless the owner sets one, and a second confirmation
  before saving "no selling". Support 24-hour branches.
- Offer Sri Lanka public and poya holidays as dated exceptions for the owner to confirm. The app
  suggests holidays; it does not decide legal trading hours.
- Built in W7: the model is `BranchHours` in `packages/shared/src/branch-hours.ts`, the API and
  migration are described in `API_CONTRACT.md` ("Branch hours"), and the editor is Settings →
  Branches → Opening hours. Mandatory limits are owner-only. Holidays come from one JSON file per
  year, copied from that year's government gazette and checked by a person
  (`apps/api/src/tenant/holidays/README.md`); a year without a file suggests nothing.

## Copy patterns

| Situation | Web copy |
| --- | --- |
| An execute button is replaced at a live branch | "Do this at the counter in PharmaCeylon POS." |
| An approved document waits for execution | "Approved — waiting at the counter", with the branch and who can do it |
| A material edit after approval | "Changed since approval — needs fresh approval." |
| A note-only edit after approval | No warning; the approval stands |
| A setting that feeds grants or snapshots | "Applies to counters after their next sync." |
| A web-POS fallback is active | "Web POS fallback is on for this branch until {time}. Sales are recorded as fallback sales." |
| Someone isn't prepared on a counter | "{Name} can't sign in offline on {counter} until they sign in there once online." |

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
| W1 | Rollout switch with go-live checklist and fallback state, API-code handling, approval-evidence panel, counter-handoff state, permission-driven nav | A |
| W2 | Web POS sunset: link replacement, per-branch hiding, owner fallback, code deletion after a settling-in period | A, B, E |
| W3 | Users, roles, PIN status, delegation, sign-in and sessions, cashier-only landing | A–C |
| W4 | Sales page, receipt copies, remote refund authorization and recovery queues | A, B, D |
| W5 | Operations handoffs per workflow; attributed phone count entry; stock discrepancy cases page | A–D |
| W6 | Counters and devices admin | B–D |
| W7 | Structured branch hours and the settings counters need | A–C |
| W8 | Onboarding and get-started for desktop POS; demo data | B |
| W9 | Dashboards, daily work and notifications | A, C–D |
| W10 | Reports and audit across counters, shifts and offline periods | B, D |

Phases follow the P-epic gates. A: start now. B: P1's boundary on and P2's online POS live at a
branch. C: P6 core workflows split and P3 grants ready. D: P5 sync and reconciliation accepted.
E: P7 pilot passed, every branch live, and the settling-in period over.

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
- P7 #53 item 11: reuse the W1 rollout switch and its fallback state (D-W7).
- P1 #47: when W5 adds phone count entry, reclassify `PATCH /stocktakes/:id/lines` (D-W3), and
  make browser-checkout denial follow each branch's live and fallback state (D-W1).

## Not changing

Catalog, pricing, suppliers, purchase orders, invoices, debit notes and customer records stay
managed on the web as today. Revised D10 permits remote management of all of them.
