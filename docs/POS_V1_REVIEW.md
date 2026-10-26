# POS v1 product decision review

Review opened 2026-10-20. Shafeek requested simple questions, one at a time, with comments.
Product review completed 2026-10-20: D1–D14 and staff follow-ups D7a/D7b are agreed.
Decisions 8, 10 and 13 were amended and approved on 2026-10-21; current rules and history are
recorded below. The same review approved the operational-readiness improvements.
Web back-office decisions D-W1–D-W7 were decided on 2026-10-27; see the section of that name below.
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
This decision record supersedes the original escrow wording and is the basis for the updated P0 tracker.

## Review queue

| ID | Decision in simple terms | Agreed v1 behaviour | Status |
| --- | --- | --- | --- |
| D1 | What if a completed offline sale finds too little stock when it syncs? | Keep the sale/payment once, open a visible stock discrepancy for manager review, pause sales from the affected batches while stock posting is pending. Other products continue normally. Never silently delete a sale or invent stock. | Approved by Shafeek, 2026-10-20 |
| D2 | Which actions work without internet? | Ordinary non-prescription/non-controlled sales/cart edits, approved staff/shift lifecycle and narrow D8/assisted-handover/support-evidence protocols. Returns, refunds, completed-sale voids, stock changes and general approvals wait for internet. | Approved by Shafeek, 2026-10-20 |
| D3 | How long may offline selling continue? | Permission auto-refreshes online and lasts at most 24 hours from the last successful online renewal; expiry stops new offline sales until online renewal. Saved sales remain available for sync. | Approved by Shafeek, 2026-10-20 (24 hours selected) |
| D4 | How recent must the saved stock be when an outage starts? | At most 15 minutes old, checked at the original outage start. Older stock blocks starting offline sales until successful sync. This does not shorten a running outage to 15 minutes. | Approved by Shafeek, 2026-10-20 |
| D5 | What payment methods work offline? | Cash and separately approved external card payments, including cash/card split payments; no wallet or customer credit. | Approved by Shafeek, 2026-10-20 |
| D6 | Can offline prices or discounts change? | Use saved prices/tax; no discounts or manual price overrides. Completed offline receipts keep the amounts charged; new prices apply after fresh sync. | Approved by Shafeek, 2026-10-20 |
| D7 | Can staff switch shifts or sign in while offline? | Staff switching is required; D7a approves prepared staff with personal PINs and D7b approves closing/opening shifts on the same till. Preserve sale attribution, stock usage and expiry. D9 removes proposed sale-count/value caps. | Agreed through D7a/D7b, 2026-10-20; original restriction rejected |
| D7a | Who can sign in offline, and how? | Staff already authorized/prepared on this terminal while online use their own offline PIN. New accounts, permissions and PIN setup/reset require internet. | Approved by Shafeek, 2026-10-20 |
| D7b | Can staff close a shift and open the next one during an outage? | Allow recorded closing cash count and next shift opening cash on the same till. Save shifts/sales separately, mark not yet synced, preserve stock usage, limits and expiry. | Approved by Shafeek, 2026-10-20 |
| D8 | Can selling continue outside scheduled business hours? | Prepared local manager may acknowledge a bounded continuation with a reason. Mandatory restrictions and the original grant expiry cannot be overridden. Closing/counting remains allowed. | Revised and approved, 2026-10-21 |
| D9 | What limits should apply to offline sale count and value? | No additional sale-count/per-sale-value/total-value caps. Use the 24-hour expiry; retain the other approved stock, hours, staff and operation/payment checks. | Approved by Shafeek, 2026-10-20 (expiry only) |
| D10 | Which online actions require the local desktop app? | Online remote management/approvals are permitted with branch authority; physical stock, branch cash, refund execution and clinical dispensing require local enrolled execution. Existing D13 designation restriction remains. | Revised and approved by Shafeek, 2026-10-21 |
| D11 | What happens when the offline-capable device is lost or replaced? | Enroll replacement online; online use can begin immediately. Offline use waits for confirmed old-device disable or old permission expiry, plus recovery/review of missing sales. | Approved by Shafeek, 2026-10-20 |
| D12 | What happens when internet returns? | Pause new checkouts on nominated terminal; sync journal/uncertain submissions and install fresh stock/review blocks before resuming. Other counters continue; accepted discrepancy cases do not block unrelated stock. Failed sync stays paused with a clear issue. | Approved by Shafeek, 2026-10-20 |
| D13 | Who may assign/change the offline device? | Owner or explicitly delegated manager authorizes online, including remotely; authorized staff activates locally online on the exact target. D11 clearance, uniqueness/version and separate actor audit remain. | Revised and approved, 2026-10-21 |
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

### D8 — Routine schedule acknowledgement; mandatory restrictions remain hard limits

- Original answer, 2026-10-20: "Approve saved hours and preapproved extensions". The blanket
  prohibition on local offline continuation is superseded by the approved 2026-10-21 scenario review.
- Current rule: outside the routine business schedule, an authenticated prepared local manager
  with an explicit signed capability may record a reasoned, bounded acknowledgement. Persist it
  before dependent sales/shift opening and retain it for sync/audit. It cannot extend the grant's
  original 24-hour expiry or override mandatory time restrictions, stock/batch/clinical rules.
- Cash counting/closing remains available outside sales hours with valid permission. This grants
  no general offline approval authority. See the readiness contract for evidence and scenarios.

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

### D10 — Remote management and local physical execution (revised)

- Original answer, 2026-10-20: "Approve desktop-only operational changes". That blanket
  rule is superseded; retained here only as decision history.
- Revision approved, 2026-10-21: "yes lets first change decision 10 with above proposal as
  exactly you mentioned." Shafeek also requested alignment of the other epics.
- Authorized owners/managers can prepare/edit/review/approve/reject purchasing, transfer,
  return/refund and adjustment requests remotely online; manage products, prices, suppliers
  and administrative customer contacts; record bank payments with evidence.
- Physical receiving/dispatch/receipt, goods inspection/disposition, executed refunds, actual
  counts/stock corrections/quarantine, branch cash and clinical verification/dispensing require
  the locally attended enrolled terminal with existing branch/role/clinical checks.
- Approval alone does not post on-hand stock, physical cash or an executed refund. Normal
  business reservations/commitments remain permitted and may reduce normal availability.
- Bind approval to the exact document version/content and action; material edits require fresh
  approval. Audit requester/approver/executor separately. Existing self-approval policy applies;
  an on-site authorized manager may approve and execute where permitted, retaining both records.
- Mixed approve-and-post endpoints must be split; until split use local execution restrictions.
  No owner bypass of physical/clinical checks. Revised D13 now permits remote online assignment authorization with separate local online activation.
- Offline scope, snapshot, expiry, PIN/shift, reconnect and replacement policies are unchanged.
  See the normative matrix in [POS_V1_CONTRACT.md](POS_V1_CONTRACT.md).
- This P0 revision updates contracts and plans; runtime enforcement remains P1/P2/P6 work.

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

### D13 — Remote assignment authorization and local target activation

- Original answer, 2026-10-20: "Owner, with delegation to selected managers". Owner/delegation
  control is retained; requiring that authorizer to attend locally is superseded on 2026-10-21.
- Owner or explicitly delegated branch manager authorizes the exact target enrollment online,
  including remotely. No automatic manager entitlement or onward delegation.
- A separately authorized local staff member confirms activation on the exact enrolled target
  online. Revalidate live authorizer/delegation, target, expected nomination version and stored
  authorization. Consume authorization and enforce uniqueness/D11 clearance atomically.
- Audit authorizer and local activator separately. Authorization alone creates no nomination/grant.
  Offline authorization/activation and overlapping usable grants remain prohibited.

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

## Operational-readiness amendments — approved 2026-10-21

Shafeek instructed: "Ok, make those changes, and also the improvements u suggested. Update the
contracts, epics, descriptions etc. and create the MR also". This approves the prior scenario
assessment's D8/D13 revisions and supporting improvements; recommendations alone were not treated
as approval. Other reviewed decisions remain, with these implementation clarifications:

- D1: evidence-led settlement timeline/counts, limited batch blocks and no fabricated/double stock.
- D2: measure ordinary-item continuity in the pilot; improve backup connectivity rather than
  implicitly expanding offline prescription/controlled dispensing.
- D3/D4/D9: frequent online refresh, exact visible expiry and pre-outage readiness. No count/value caps.
- D5/D6: durable payment intents/reference recovery; discounted carts require explicit review before
  payment, no silent total changes, repricing or automatic second charge.
- D7b: narrow prepared-manager assisted closure for an absent cashier, retaining original cashier,
  actual counting manager and variance. No shared login or rewritten outgoing cashier records.
- D12: stable authenticated reconnection, safe checkout/payment boundary, persisted support evidence,
  pause/drain, resolve uncertain outcomes, then fresh stock/review blocks. Failed drain stays paused.
- D14: separate app restart from OS reboot/power cut; prove time continuity and durable state in
  runtime tests before rollout. Unknown time/data still requires online recovery.
- Append-only offline sale-incident notes add no refund, stock or cash authority.
- Supported local-session checks plus named staff confirmation/audit; no perfect presence claim.
- Material approval revisions exclude nonmaterial notes and ordinary execution counters.

Normative detail and epic acceptance mapping: [POS_V1_OPERATIONAL_READINESS.md](POS_V1_OPERATIONAL_READINESS.md).

## Web back-office decisions — decided 2026-10-27

Shafeek reviewed seven questions about how the web app changes once checkout and physical
execution move to the enrolled desktop. Each question was asked separately with its options and
trade-offs, and Shafeek selected an option for every one. Each selection happened to be the
recommended option; it is recorded because Shafeek selected it, not because it was recommended.
The resulting web target state is in [WEB_BACKOFFICE_TARGET.md](WEB_BACKOFFICE_TARGET.md).

| ID | Decision in simple terms | Agreed behaviour | Status |
| --- | --- | --- | --- |
| D-W1 | How does the web POS go away? | A per-branch "desktop POS live" switch hides the web POS one branch at a time; branches not yet live keep it. Delete the web POS code after the P7 pilot, once every branch is live. | Decided by Shafeek, 2026-10-27 |
| D-W2 | How does opening stock get in during onboarding? | Stage it on the web (import or entry) as a draft with no stock effect. The enrolled counter confirms it against the shelf and posts it. No pre-go-live exemption. | Decided by Shafeek, 2026-10-27 |
| D-W3 | How are stocktake counts captured? | Only in the enrolled desktop app in v1, on a laptop or tablet. Web and phone count sheets become read-only progress views; counting on an enrolled mobile device is a later epic. | Decided by Shafeek, 2026-10-27 |
| D-W4 | What web access do cashier-only staff have? | My Profile and Password & Security only, landing on a "Use PharmaCeylon POS" page. Their API permissions are unchanged because the desktop uses them. | Decided by Shafeek, 2026-10-27 |
| D-W5 | How do staff PINs work? | One personal PIN, set at the counter while online. The server keeps its verifier for online co-sign and refund approval; each prepared terminal keeps its own local verifier. The web shows PIN status and resets it, but never sets one. | Decided by Shafeek, 2026-10-27 |
| D-W6 | Who owns branch hours? | The web settings epic (W7) owns the structured model, API, migration from free-text `openingHours` and the web editor. P3 signs it into grants; P2 uses it on the desktop. | Decided by Shafeek, 2026-10-27 |
| D-W7 | Where is the per-branch rollout switch built? | Once, in the web foundation epic (W1). P7 reuses it for release. It controls rollout only, never authorization. | Decided by Shafeek, 2026-10-27 |

### D-W1 — Web POS sunset per branch

- Date: 2026-10-27.
- User answer: selected "Per-branch switch".
- Agreed behaviour: when a branch's switch is on, the web hides POS navigation, the Quick Sale
  button, the search action and every deep link into `/pos`, and `/pos` explains that checkout has
  moved to PharmaCeylon POS. Branches not yet live keep the web POS. The web POS code is deleted
  after the P7 pilot, once every branch is live.
- Alternatives not chosen: removing the web POS for every tenant at once; keeping it as a
  permanent fallback, which would have needed a D10 change.
- Contract record: no contract change. P1's denial of browser checkout and the switch must flip
  together for each branch, or that branch cannot sell.

### D-W2 — Opening stock staged on the web, posted at the counter

- Date: 2026-10-27.
- User answer: selected "Stage on web, post at counter".
- Agreed behaviour: during onboarding, the owner imports or enters opening stock on the web as a
  staged draft (products, batches, expiry dates, quantities and costs) with no stock effect. The
  enrolled counter confirms the figures against the shelf and posts them.
- Alternatives not chosen: a pre-go-live exemption letting the web post stock until the first
  sale or first enrolled counter; entering all opening stock at the counter.
- Contract record: clarifies the D10 matrix in [POS_V1_CONTRACT.md](POS_V1_CONTRACT.md) and the
  `onboarding/*`, `setup/readiness/*` and `products/*` rows of
  [POS_OPERATIONAL_MUTATIONS.md](POS_OPERATIONAL_MUTATIONS.md). The existing `opening_inventory`
  readiness confirmation already requires a local terminal. No onboarding exemption may post stock.

### D-W3 — Stocktake counts captured in the desktop app only

- Date: 2026-10-27.
- User answer: selected "Desktop app only in v1".
- Agreed behaviour: counts are captured in PharmaCeylon POS on an enrolled laptop or tablet. The
  web keeps planning, scheduling, assignment, line selection, review, recount requests and
  approval, and shows count progress read-only, including on phones.
- Alternatives not chosen: phone drafts confirmed at the desktop, where the confirmer rather than
  the counter would be the attested person; enrolling phones as counting devices before v1.
- Contract record: clarifies the D10 matrix. `PATCH /stocktakes/:id/lines` and the `start`,
  `submit` and `complete` routes are already classified `local_record`; no route changes.

### D-W4 — Cashier-only staff use the web for their own account only

- Date: 2026-10-27.
- User answer: selected "Profile and password only".
- Agreed behaviour: a user whose roles at the selected branch give no back-office access sees
  My Profile and Password & Security (and personal display settings), and lands on a
  "Use PharmaCeylon POS" page.
- Alternatives not chosen: a small cashier dashboard of their own sales and shifts; no web
  sign-in at all.
- Contract record: none. This is web scoping, not authorization. Built-in cashiers keep their API
  permissions (`products.view`, `customers.view`, `sales.view` and others) because the desktop
  needs them. W3 decides it through a role setting, not a role-name check, so custom roles work too.

### D-W5 — One personal PIN, set at the counter

- Date: 2026-10-27.
- User answer: selected "One PIN, set at the counter".
- Agreed behaviour: each person has one PIN. They set or change it on the desktop while online.
  The server keeps a verifier for online pharmacist co-sign and refund approval; each terminal the
  person is prepared on keeps its own local verifier. The web shows PIN status and can reset it.
- Alternatives not chosen: separate till and offline PINs; leaving the choice to P2.
- Contract record: refines D7a without changing it. PIN setup and reset still require internet;
  self-service setup moves from web POS Quick Actions to the desktop. P2 must still keep PINs and
  verifiers out of grants, commands, sign-in evidence, logs and sync payloads.

### D-W6 — Branch hours owned by the web settings epic

- Date: 2026-10-27.
- User answer: selected "W7 owns it".
- Agreed behaviour: W7 replaces free-text `Branch.openingHours` with a structured weekly schedule,
  dated exceptions, mandatory restrictions and online business extensions, migrates the existing
  text, and builds the web editor. P3 signs these into grants; P2 uses them on the desktop.
- Alternatives not chosen: P3 owning it; P2 owning it.
- Contract record: D8's signed `operatingWindows` / `mandatoryOperatingWindows` semantics,
  including null versus empty, are unchanged. P2 #48 and P3 #49 should name W7 as the source.

### D-W7 — One rollout switch, built by the web foundation epic

- Date: 2026-10-27.
- User answer: selected "Build in W1, P7 reuses".
- Agreed behaviour: the per-branch "desktop POS live" switch is built once, early, in W1. P7's
  tenant/branch rollout controls reuse it.
- Alternatives not chosen: waiting for P7's controls, which would delay the per-branch sunset;
  separate web and release flags that could drift apart.
- Contract record: the switch controls rollout only. It never grants authority or bypasses an
  API check. P7 #53's rollout-controls item should point at the W1 switch.

## Review completion and remaining engineering work

All requested product decisions are recorded. No further unanswered product-review forms remain.
The 2026-10-27 web back-office decisions extend this review to the web app; the remaining
edits to GitHub epic descriptions are listed in [WEB_BACKOFFICE_TARGET.md](WEB_BACKOFFICE_TARGET.md).
This completes the user policy walkthrough; it does not claim the actual POS features are built.
Shafeek subsequently directed that staffing/allocation is his responsibility and that this workflow
should treat him as the developer. The earlier second-developer naming/ownership sign-off is
withdrawn; no approval from another person is inferred or required here. Follow P1–P7 for runtime enforcement, migrations, local persistence,
OS/security testing, reconciliation and rollout. Keep GitHub epic descriptions aligned with these
decisions; downstream implementations must replace any remaining original escrow assumptions.

The technical [developer integration guide](POS_V1_DEVELOPER_CONTRACT.md) preserves the component
contracts and verification without assigning people or imposing staffing approval gates.
