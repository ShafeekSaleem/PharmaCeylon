# POS v1 product decision review

Review opened 2026-10-20. Shafeek requested simple questions, one at a time, with comments.
Product review completed 2026-10-20: D1–D14 and staff follow-ups D7a/D7b are agreed.
Record an answer only when the user explicitly provides it. Recommendations, code, elapsed time,
or an unanswered/preselected form choice are not approval. Pending behaviour is provisional in
the contracts/tests and must be revised when the user chooses differently.

## Approved architecture

Approved by Shafeek in this chat on 2026-10-20: snapshot-based v1, all online counters use normal
shared available stock, one device per branch designated offline-capable during online enrollment,
automatic offline operation on that device using its latest local snapshot. No advance stock
reservation, outage-time percentage allocation, multiple offline sellers or branch hub.

The comparison explained that snapshot stock can conflict with sales made by other connected
counters. All decisions below are agreed, including the 24-hour permission limit, 15-minute
snapshot age at outage start, prepared-staff PIN sign-in and offline shift handover. The current
decision table is authoritative; answer entries also preserve how earlier proposals changed.
This local record supersedes older escrow wording in the GitHub epic; no GitHub issue was edited.

## Review queue

| ID | Decision in simple terms | Agreed v1 behaviour | Status |
| --- | --- | --- | --- |
| D1 | What if a completed offline sale finds too little stock when it syncs? | Keep the sale/payment once, open a visible stock discrepancy for manager review, pause sales from the affected batches while stock posting is pending. Other products continue normally. Never silently delete a sale or invent stock. | Approved by Shafeek, 2026-10-20 |
| D2 | Which actions work without internet? | Ordinary non-prescription/non-controlled sales and edits to an unfinished cart only. Returns, refunds, voids of completed sales, stock changes and approvals wait for internet. | Approved by Shafeek, 2026-10-20 |
| D3 | How long may offline selling continue? | Permission auto-refreshes online and lasts at most 24 hours from the last successful online renewal; expiry stops new offline sales until online renewal. Saved sales remain available for sync. | Approved by Shafeek, 2026-10-20 (24 hours selected) |
| D4 | How recent must the saved stock be when an outage starts? | At most 15 minutes old, checked at the original outage start. Older stock blocks starting offline sales until successful sync. This does not shorten a running outage to 15 minutes. | Approved by Shafeek, 2026-10-20 |
| D5 | What payment methods work offline? | Cash and separately approved external card payments, including cash/card split payments; no wallet or customer credit. | Approved by Shafeek, 2026-10-20 |
| D6 | Can offline prices or discounts change? | Use saved prices/tax; no discounts or manual price overrides. Completed offline receipts keep the amounts charged; new prices apply after fresh sync. | Approved by Shafeek, 2026-10-20 |
| D7 | Can staff switch shifts or sign in while offline? | Staff switching is required; D7a approves prepared staff with personal PINs and D7b approves closing/opening shifts on the same till. Preserve sale attribution, stock usage and expiry. D9 removes proposed sale-count/value caps. | Agreed through D7a/D7b, 2026-10-20; original restriction rejected |
| D7a | Who can sign in offline, and how? | Staff already authorized/prepared on this terminal while online use their own offline PIN. New accounts, permissions and PIN setup/reset require internet. | Approved by Shafeek, 2026-10-20 |
| D7b | Can staff close a shift and open the next one during an outage? | Allow recorded closing cash count and next shift opening cash on the same till. Save shifts/sales separately, mark not yet synced, preserve stock usage, limits and expiry. | Approved by Shafeek, 2026-10-20 |
| D8 | Can the shop sell offline outside configured opening hours? | New sales only within saved hours or extensions preapproved online; cash counting/closing an existing shift is allowed after sales hours. The 24-hour permission expiry still applies. | Approved by Shafeek, 2026-10-20 |
| D9 | What limits should apply to offline sale count and value? | No additional sale-count/per-sale-value/total-value caps. Use the 24-hour expiry; retain the other approved stock, hours, staff and operation/payment checks. | Approved by Shafeek, 2026-10-20 (expiry only) |
| D10 | Which online actions require the local desktop app? | Operational sales/stock/catalog/patient/procurement writes require the enrolled desktop used locally at the branch, including for owners. Web/mobile retain permitted oversight/administration; remote desktop cannot perform operational changes. | Approved by Shafeek, 2026-10-20 |
| D11 | What happens when the offline-capable device is lost or replaced? | Enroll replacement online; online use can begin immediately. Offline use waits for confirmed old-device disable or old permission expiry, plus recovery/review of missing sales. | Approved by Shafeek, 2026-10-20 |
| D12 | What happens when internet returns? | Pause new checkouts on nominated terminal; sync journal/uncertain submissions and install fresh stock/review blocks before resuming. Other counters continue; accepted discrepancy cases do not block unrelated stock. Failed sync stays paused with a clear issue. | Approved by Shafeek, 2026-10-20 |
| D13 | Who may assign/change the offline-capable device? | Owner, with explicit delegation to selected branch managers; no automatic manager access. Assignment/change requires online local attendance and audit, with one designation per branch and D11 replacement checks. | Approved by Shafeek, 2026-10-20 |
| D14 | What if the device restarts and cannot trust its clock or saved journal? | Resume the same outage only with safely restored journal, stock, staff/shift state, trusted clock and original expiry. Otherwise require online recovery; retain recoverable sales and never reset the 24-hour period. | Approved by Shafeek, 2026-10-20 |

Technical integrity defaults support these choices: signed device commands, signed server
snapshots/permissions, encrypted local storage, integer money/base-unit quantities, durable
journaling and retry-safe receipts. Explain any technical trade-off if it changes staff workflow;
do not ask the user to choose cryptographic algorithms without a product consequence.

## Answers and comments

### D1 — Stock shortage after sync

- Date: 2026-10-20.
- User answer: "Approve this handling".
- Approved behaviour: retain the completed sale and payment exactly once, flag the stock shortage
  for manager review and pause further sales from the affected batch until resolved. Other stock
  continues selling normally.
- Additional comments: none provided.
- Contract record: D1's stock discrepancy/receipt outcome and batch sale block are approved;
  the other queued policies were still pending at that step. Runtime implementation belongs to the later epics.

### D2 — Offline action scope

- Date: 2026-10-20.
- User answer: "Approve this scope".
- Approved behaviour: the nominated counter can complete ordinary non-prescription/non-controlled
  sales offline. Staff may edit or remove items from an unfinished cart. Prescription and controlled
  medicines, returns, refunds, cancellation of completed sales, stock receiving/transfers/adjustments
  and approvals require internet.
- Additional comments: none provided.
- Contract record: `ordinary_sale` is the offline command kind; server-generated snapshots contain
  only eligible products. No offline refund/void/stock command is introduced. Payment choices,
  discounts, staff sessions and time limits were still pending their separate decisions at that step.

### D3 — Offline permission lifetime

- Date: 2026-10-20.
- User answer: "Use 24 hours instead".
- Approved behaviour: automatic permission renewal while online; offline permission expires at
  most 24 hours after the last successful online renewal, not 24 hours after outage detection.
  Display expiry to staff. Stop new offline sales at expiry until online renewal; retain all
  recorded sales for later sync. No offline renewal or extension.
- Additional comments: none provided.
- Contract changes: `MAX_OFFLINE_GRANT_MS` and the grant fixture now use 24 hours. The expiry
  fixture checks the exact 24-hour boundary and rejects longer grants. D4 snapshot freshness
  and the other decisions were still pending at that step; later answers are recorded below.

### D4 — Snapshot freshness at outage start

- Date: 2026-10-20.
- User answer: "Approve 15 minutes".
- Approved behaviour: automatically refresh stock online; the saved snapshot must be at most
  15 minutes old when the outage starts. If older, block starting offline sales until successful
  stock sync. Do not keep reapplying this age limit during the same outage or reset the original
  outage start on restart/connection flaps. The independent 24-hour permission expiry still applies.
- Additional comments: none provided.
- Contract changes: `MAX_SNAPSHOT_AGE_AT_OUTAGE_MS` is 15 minutes and grant validation binds
  the v1 policy to that value. Fixtures cover the exact limit, an over-age snapshot, continued
  selling beyond 15 minutes within the authorized outage and rejection of a different grant limit.

### D5 — Offline payment methods

- Date: 2026-10-20.
- User answer: "Approve cash + approved card payments".
- Approved behaviour: accept cash and card payments actually approved by a separate card machine,
  including combined cash/card payment on a sale. The POS records the independent approval/reference
  and does not authorize card transactions. Mobile wallets and customer credit/pay-later require internet.
- Additional comments: none provided.
- Contract record: `OfflinePayment` supports only cash and independently approved external card
  entries. Payment totals must match the sale; independent card approval details remain required.
  Fixtures verify split tender and reject unsupported wallet/credit methods.

### D6 — Offline prices and discounts

- Date: 2026-10-20.
- User answer: "Approve saved prices, no offline discounts".
- Approved behaviour: use prices and tax settings from the last successful sync. No manual
  price changes or discounts while offline. Preserve the prices/tax and amounts actually charged
  on completed offline sales; syncing does not reprice receipts. New prices apply after fresh sync.
- Additional comments: none provided.
- Contract record: sale lines bind to their signed snapshot prices and require zero discount.
  Fixtures reject changed unit prices and nonzero discounts. API/desktop adapters must reproduce
  existing monetary conversion and tax semantics; this approval does not authorize a new tax policy.

### D7 — Offline staff switching required

- Date: 2026-10-20.
- User answer: "I need staff switching while offline".
- Decision: reject the original single-cashier restriction; v1 must support offline staff switching.
  This does not approve any particular offline sign-in method or rules for opening/closing shifts.
- Additional comments: none provided.
- Contract changes: the draft grant supports multiple `authorizedSessions`, and each sale identifies
  its staff session. Stock consumption, grant usage and original outage/expiry remain terminal-wide.
  Fixtures allow a second authorized staff session while retaining stock/cap enforcement and reject
  forged session/till changes. This is contract scaffolding; actual local authentication is not implemented.
- At this step, D7a/D7b remained to be reviewed. The later approved decisions below supersede
  the temporary `authorizedSessions` scaffolding.

### D7a — Prepared staff may sign in using their own PIN

- Date: 2026-10-20.
- User answer: "Approve prepared staff with their own PIN".
- Approved behaviour: staff previously authorized for this branch and prepared for offline access
  on this terminal may sign in with their personal PIN configured while online. They need not be
  the original cashier. Attribute each sale to the actual staff member. New accounts/permissions
  and PIN setup/reset require internet.
- Additional comments: none provided.
- Contract changes: staff session authorizations identify the prepared staff authorization and
  credential version. `OfflineStaffSignIn` records signed, secret-free evidence of a successful
  local PIN check; sales reference the sign-in ID. Fixtures require matching identity/session and
  credential-version evidence. Actual credential verification/storage remains P2/P4 work.
- At this step, shift lifecycle remained pending D7b. The later decision below replaces the
  temporary preauthorized work-session list with prepared staff plus locally created shifts.

### D7b — Close and open shifts offline

- Date: 2026-10-20.
- User answer: "Allow closing and opening shifts offline".
- Approved behaviour: outgoing staff record the closing cash count and close their shift; incoming
  prepared staff sign in and open the next shift on the same till with their opening cash count.
  Each shift/sales remain separately recorded and marked not yet synced until acknowledged.
  No reset of stock, selling limits, original outage time or the 24-hour permission expiry.
- Additional comments: none provided.
- Contract changes: `OfflineGrant` fixes the register/till and lists `authorizedStaff` rather than
  requiring online-created work sessions. New `shift_open` and `shift_close` commands share the sales
  journal sequence. `offlineShiftTransition` models one active shift, immutable close/variance,
  new local session IDs and protection against reuse. Sale policy requires the matching open shift.
  Sync/receipt contracts now identify shift resources as well as sales; runtime persistence remains P2/P4/P5 work.

### D8 — Saved opening hours and preapproved extensions

- Date: 2026-10-20.
- User answer: "Approve saved hours and preapproved extensions".
- Approved behaviour: allow new offline sales only during saved branch hours or an extended-hours
  exception approved and saved while online. No manager-created offline extension. Cash counting
  and closing an existing shift remain possible after sales hours. The separate 24-hour permission
  expiry still applies.
- Additional comments: none provided.
- Contract changes: existing signed operating windows/exception control sales; shift-close policy
  now permits after-hours cash recording/closure without permitting new sales or bypassing grant expiry.
  Fixtures verify sales block, allowed closing, blocked after-hours reopening and unchanged expiry.

### D9 — No sale-count or value caps

- Date: 2026-10-20.
- User answer: "Use the 24-hour expiry only".
- Approved behaviour: no offline sale-count cap, per-sale value cap or cumulative sales-value cap;
  no owner/branch configuration of those caps. Retain the 24-hour permission expiry and all other
  approved rules, including local stock, snapshot freshness, hours, staff, allowed actions and payments.
- Additional comments: none provided.
- Contract changes: remove the three cap fields, `CAP_EXCEEDED`, cap-only usage counters and
  enforcement. Keep monetary validity/overflow checks. Regression fixture permits a sale above both
  former example amount caps after a large journal sequence, while still enforcing local stock.
  Earlier entries that mention preserving caps describe the proposal before this D9 decision.

### D10 — Local desktop required for operational changes

- Date: 2026-10-20.
- User answer: "Approve desktop-only operational changes".
- Approved behaviour: sales, refunds, stock operations, product/price changes, purchasing and
  customer/prescription edits require an enrolled desktop used locally at the branch. Remote desktop
  sessions cannot perform those operations, including for an owner. Web/mobile retain permitted
  reporting, oversight, user management and settings. Existing web operational editing becomes
  read-only or directs staff to the desktop; permissions still apply in every client.
- Additional comments: none provided; no operational-edit exceptions requested.
- Contract record: operational command and mutation-inventory documentation mark D10 approved.
  P1/P2 enforce verified device/local-session evidence, rather than trusting client headers or
  bypassing the boundary for owners. These P0 edits do not yet disable existing web/API operations.

### D11 — Lost-terminal replacement

- Date: 2026-10-20.
- User answer: "Approve this replacement process".
- Approved behaviour: enroll the replacement while online and permit normal authorized online
  operation immediately. Offline permission waits until the old device is confirmed disabled or
  its old permission has expired, and its unsynced sales have been recovered or reviewed as missing.
  Server-side revocation alone is not proof a disconnected old device stopped. A lost device may
  require waiting out the remainder of its 24-hour permission to avoid two usable offline sellers.
- Additional comments: none provided.
- Contract record: `mayEnableOfflineReplacement` requires both old-grant cutoff and journal
  resolution/loss review. Existing fixtures exercise all combinations and reject reuse of the
  old enrollment. No new runtime behaviour or additional wait beyond the approved process is introduced.

### D12 — Pause, synchronize, then resume checkout

- Date: 2026-10-20.
- User answer: "Approve pause, sync, then resume".
- Approved behaviour: the nominated terminal pauses new checkouts and displays "Synchronizing";
  uploads saved sales and shift records, resolves uncertain submissions and installs fresh stock
  before resuming online checkout. Other connected counters continue normally. Accepted stock
  discrepancy cases leave their affected batches blocked without pausing the whole terminal.
  Failed/incomplete sync leaves this terminal paused with a clear issue; no stock/timer reset.
- Additional comments: none provided.
- Contract changes: `OnlineCheckoutResumeEvidence` and `mayResumeOnlineCheckout` require verified
  authentication, full local journal acceptance, uncertain-command resolution, fresh snapshot and
  installed review blocks. Fixtures cover each missing requirement and forbid an incomplete drain
  from directly refreshing or falling back into a new offline session.

### D13 — Owner control with selected-manager delegation

- Date: 2026-10-20.
- User answer: "Owner, with delegation to selected managers".
- Approved behaviour: owner has designation control by default and may explicitly delegate it to
  selected branch managers; manager role alone is insufficient. Assignments/changes require internet,
  local use at the branch and an audit record of who changed what. One designated terminal per branch;
  D11's replacement clearance continues to apply.
- Additional comments: none provided.
- Contract changes: per-user/per-branch `OfflineTerminalDelegation`, versioned target assignment
  body and `mayManageOfflineTerminal` policy using trusted context. Fixtures permit owner/delegated
  manager and reject undelegated managers, other roles, offline requests and remote attendance.
  P1/P2 must implement live authorization, persistence, audit and uniqueness; no current API guard changed.

### D14 — Safe restart restoration or online recovery

- Date: 2026-10-20.
- User answer: "Approve safe restore, otherwise online recovery".
- Approved behaviour: normal restart may resume offline selling only with safely restored saved
  sales/journal, stock balance/usage, staff/shift state, trusted time and original permission expiry.
  Damaged journals or an untrusted/rolled-back clock stop new offline sales pending online recovery.
  Retain all recoverable sales; never silently clear them. Restarting or switching staff cannot
  reset the original outage or begin a fresh 24-hour permission period.
- Additional comments: none provided.
- Contract changes: `OfflineRecoveryBoundary`, `OfflineRestartEvidence` and `offlineRestartDecision`
  preserve the original grant/outage/snapshot/journal boundary, fail closed on lost or altered state,
  preserve interrupted sync pauses and reject expiry/revocation bypass. Fixtures exercise these
  outcomes without modifying the saved evidence. Runtime disk/clock verification remains P4/P5 work.

## Review completion and remaining engineering work

All requested product decisions are recorded. No further unanswered product-review forms remain.
This completes the user policy walkthrough; it does not claim the actual POS features are built.
Shafeek subsequently directed that staffing/allocation is his responsibility and that this workflow
should treat him as the developer. The earlier second-developer naming/ownership sign-off is
withdrawn; no approval from another person is inferred or required here. Follow P1–P7 for runtime enforcement, migrations, local persistence,
OS/security testing, reconciliation and rollout. GitHub epic descriptions still need a coordinated
update to replace the original escrow proposal; no GitHub issue/comment was written by this chat.

The technical [developer integration guide](POS_V1_DEVELOPER_CONTRACT.md) preserves the component
contracts and verification without assigning people or imposing staffing approval gates.
