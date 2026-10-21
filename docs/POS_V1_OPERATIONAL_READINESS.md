# POS v1 operational readiness and scenario contract

Approved by Shafeek on 2026-10-21 following the real-life P0 assessment. This amends D8/D13
and clarifies the retained decisions. It supplements the [specification](POS_V1_CONTRACT.md),
[decision history](POS_V1_REVIEW.md) and [developer guide](POS_V1_DEVELOPER_CONTRACT.md).
These are contracts, typed evidence and pure policy fixtures; runtime implementation remains P1–P7.

## Retained scope

Keep one nominated offline seller, normal shared online availability and last-known snapshots.
No offline stock reservations, hub, percentage partitions, transaction/value caps or automatic
replacement. Retain 24-hour expiry from online renewal, the 15-minute outage-entry freshness
check, saved prices/tax, no discounts/overrides, prepared personal PINs, same-till handovers,
ordinary non-prescription/non-controlled sales and cash/independently approved external card.
General offline approvals, prescriptions/controlled dispensing, refunds/voids and stock operations
remain excluded. D8 acknowledgement, assisted closure and nonfinancial support records are narrow
local exceptions, not a generic offline management API. Revised D10 remains in force.

Snapshots are not a guarantee that stock is still available. Staff verify actual product, batch,
quantity, expiry and visible condition before handing goods over. Later online reservations,
quarantine/recalls and other counters' sales may not reach a disconnected device. Do not promise
instant revocation or safety-alert delivery while offline. Existing eligibility checks remain;
do not infer that any particular medicine is suitable for offline sale from this architecture.

## D8: routine closing time versus mandatory restrictions

The signed grant separates routine `operatingWindows` and optional online business extensions
from `mandatoryOperatingWindows`. Mandatory null means no extra mandatory time restriction;
empty means no selling. Configuration must reflect verified branch requirements; this contract
does not decide which legal restrictions apply. No local acknowledgement overrides those windows.

Example: ten customers remain at routine closing time during an outage. A prepared manager with
the signed `acknowledge_business_hours` capability authenticates with their own PIN, records a
reason and end time, and confirms the warning. Persist the signed acknowledgement before sales.
Its record ID, grant/version/nomination, branch/device, original outage and manager sign-in bind
dependent sales and shift openings. Require a fresh acknowledgement when its bounded interval ends.
It may span prepared staff/shift changes within that same bound; neither changes expiry or stock.
It never overrides mandatory windows, batch expiry, stock blocks, eligibility or the grant's expiry.
Cash count/closing of an existing shift remains possible outside selling hours with valid permission.

## D13: authorization and activation

An owner or explicitly delegated branch manager may authorize an assignment remotely online.
Store the authorizer, tenant/branch, exact enrolled target, expected nomination version and reason.
Authorization alone neither changes the active nomination nor issues offline authority.

An authorized local branch staff member then activates on the actual target device online.
The activator needs explicit branch activation permission, not the owner's assignment permission.
Verify device/local context; re-fetch and revalidate the authorizer's current delegation/authority,
target and version. Atomically consume the authorization, change the unique nomination and audit
both actors. Changed target/version or revoked/consumed authorization requires fresh authorization.
Issuing a new grant still requires D11 old-authority cutoff AND recovered/reviewed missing journal.
Remote authorization cannot waive these checks, even for an owner. Initial enrollment uses the
same target identity proof; no already-enrolled desktop is needed as a bootstrap prerequisite.

## Payments, carts and mistakes

Persist an immutable checkout draft/digest and external-card attempt ID before asking the separate
card machine to charge. Bind amounts, split tender, selected quantities, snapshot prices/tax and
staff/shift. Record each subsequent attempt-state change as an immutable event with a unique record
ID. A restarted app showing `prepared` must assume the charge may have happened; it is not proof
that no money moved. `uncertain` also requires checking the original card-machine result.

| Known result | Required recovery |
| --- | --- |
| Prepared/uncertain | Check the original attempt/reference; do not offer an automatic second charge |
| Approved | Complete/recover the original sale using that evidence, subject to sale authorization |
| Definitively declined | A new attempt may be made after review; retain the old declined attempt |
| Linked to sale | Recover/reprint the existing receipt, never create another sale/payment |

Require attributable evidence for terminal-result confirmation; no PAN, CVV, full card image,
PIN or payment credentials in records/logs. Scope provider-reference uniqueness by provider/merchant
and actual terminal semantics; do not assume a short reference is globally unique. Prevent linking
one approved attempt to multiple sales and reject altered amount/draft replays transactionally.
The POS does not authorize the card. Cash plus approved-card totals still balance exactly.
If approval occurred but the sale cannot safely complete (expiry, changed cart, damaged state),
preserve payment/draft evidence for online recovery. Do not backdate a new sale, bypass expiry,
silently abandon payment or auto-refund/recharge. Surface unresolved collected money separately
from completed sales and reconcile it in the shift/cash reports. Corrective refunds remain online.

If an online cart with a discount loses connectivity, stop before payment, show the original and
eligible offline total, and require explicit cashier/customer review. No offline discount persists
and no silent total change occurs. If payment has already started, recover that attempt first;
do not reprice or replace its reviewed draft. Completed receipts are never repriced on sync.

Staff can append a signed sale-incident note while offline, referencing the immutable sale command,
actual staff/sign-in/shift, time, category and description. Example: two units handed over but
three entered. The note has no financial/stock effect; it neither edits a receipt nor becomes an
offline refund/adjustment. Show an online review queue and preserve later resolution linkage.
Minimize sensitive patient information in free text and never put credentials in notes.

## Assisted handover

If an outgoing cashier is absent, a prepared local manager with `assist_shift_handover` may
authenticate personally and close that cashier's existing shift with a reason and actual cash count.
The signed close keeps the original cashier/work session, records the manager sign-in/counting
actor, and preserves expected cash and variance. The manager does not impersonate the cashier,
rewrite prior sales/counts or erase shortages. Missing capability/credential or reason blocks help.
The incoming prepared cashier opens a separate shift normally; selling after routine hours still
needs D8 evidence, and grant expiry, stock and enrollment-wide sequence remain unchanged.

## Readiness and reconnect boundary

Show before an outage: nominated device, last successful stock refresh/time, actual permission
expiry/remaining duration, prepared staff and manager capabilities, local storage/durability health,
clock status, unsynced command/support counts, unresolved payments and readiness reasons.
Automatically refresh substantially more often than the 15-minute limit; determine the actual
refresh cadence from load and pilot evidence. A healthy API probe is not successful stock sync.
Show unsynced value/count as information and unusual activity for review, never new sales caps.

A single successful probe must not interrupt tender. P4/P5 define and test an authenticated
connection-stability policy. Finish the current checkout or durably pause it with any payment
uncertainty recorded, then stop new checkout and enter draining. Resolve uncertain server commands
and payments during drain, upload/accept evidence and sale/shift records, then install fresh stock
and review blocks. No circular rule may require online recovery to finish before allowing recovery
uploads. Once draining, failed connectivity leaves the terminal paused; no new timer/baseline.
Other connected counters continue. Show progress, queued/review counts and an actionable error.

`OfflineSupportRecord` is a separate durable evidence stream signed with `command` purpose, with
globally scoped record IDs under tenant/enrollment plus immutable digest and original ack.
Do not consume or skip the sale/shift sequence for support records. Validate staff/time/identity
and signatures; resolve manager sign-in and hours-record dependencies before accepting commands.
Identical support retries return the original ack; changed-content ID reuse conflicts and retains
evidence for repair. A held record is not accepted. Sync support evidence even with no sale command.
Resume requires accepted support records and resolved payment attempts in addition to the existing
journal/uncertain-command/fresh-stock/review-block gates. Failed/rejected items are never cleared.

## Stock settlement and approval content

Show a manager the affected batches, completed receipts/payments, pending quantities, timestamped
online/offline sales/reservations/receipts/counts and relevant physical-count evidence. Block batches
whose stock posting remains unresolved; do not block unrelated products. Remote review/authorization
is permitted; physical counts/corrections still execute locally under D10.

`StockDiscrepancySettlementEvidence` links the case, immutable stock timeline, actual count/time,
counting actor, sale IDs already included in that count, approval and local execution/movement IDs.
Post a missing movement or link an existing settlement exactly once. A late offline journal already
reflected by a physical count must not deduct the same units again. Unlock only when all affected
pending postings are accounted for; another open case on the batch keeps its block. No fabricated
balancing receipt, hidden negative-stock bypass, partial untracked posting or sale deletion.

Approval `documentVersion`/digest cover material approved content: quantities, batches, amounts,
prices, destination and scoped action. Nonmaterial notes have separate metadata revisions and do
not invalidate approval. Normal execution counters for legitimate partial receipts are separate
from the original approved material content; enforce remaining quantities and idempotency. Do not
use note metadata to smuggle a material change past approval.

## Restart, presence and release evidence

Preserve the original journal/stock/staff/shift/outage/grant and paused state. Separate app restart
from OS reboot/power loss in diagnostics and tests. An intact database or plausible wall clock is
not proof of remaining grant time. `OfflineRestartEvidence` identifies restart kind and time proof;
same-boot elapsed-time evidence cannot authorize restoration across an OS reboot.

P4/P7 must implement and demonstrate protected time continuity on supported Windows hardware,
including downtime, rollback, suspend/resume and power loss. Unknown time requires online recovery
while retaining evidence. Gate offline rollout on tested ordinary power-loss recovery; if the
implementation cannot establish cross-boot trust, report that limitation to Shafeek before rollout
and revise the launch plan rather than weakening expiry or claiming power-cut resilience.
[Microsoft's timing documentation](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)
explains that QPC is measured since OS startup; the pure fixture is not a clock implementation.

Document/test supported remote-session detection and known third-party remote-control limitations.
Device enrollment and session evidence are useful controls, not proof a human inspected goods or
protection against a hostile local administrator. Retain named physical-action confirmation and audit.

## Required scenario evidence and epic mapping

| Scenario / acceptance | Implementation epics |
| --- | --- |
| After-hours queue: manager acknowledgement works; mandatory closure and grant expiry still block | P2 #48, P3 #49, P4 #50, P7 #53 |
| Remote assignment alone issues no grant; exact local activation, stale/delegation/target rejection and D11 cutoff | P1 #47, P2 #48, P5 #51, P6 #52, P7 #53 |
| Card approval then crash/response loss: recover original payment/sale once; no duplicate charge or lost money | P1 #47, P2 #48, P4 #50, P5 #51, P7 #53 |
| Discounted cart disconnect: explicit review before tender; started payment recovers without repricing | P2 #48, P4 #50, P7 #53 |
| Absent cashier: manager counts under own PIN; original cashier/variance retained; incoming shift separate | P2 #48, P4 #50, P5 #51, P7 #53 |
| Incident note sync retries: one review item, no receipt/stock/cash mutation or offline refund | P1 #47, P4 #50, P5 #51, P6 #52, P7 #53 |
| Stale snapshot, unprepared staff, nearly expired grant or unhealthy storage: warn before outage | P2 #48, P3 #49, P4 #50, P7 #53 |
| Connection flap during tender/drain: no interruption/duplicate charge/baseline reset; clear pause/progress | P4 #50, P5 #51, P7 #53 |
| Shortage plus later physical count/late journal: transparent timeline, one settlement and scoped block | P5 #51, P6 #52, P7 #53 |
| Note edit retains approval; changed approved quantity needs reapproval; partial receipts remain bounded | P1 #47, P6 #52, P7 #53 |
| App crash, OS reboot, power loss, rollback and damaged evidence tested separately on Windows | P4 #50, P5 #51, P7 #53 |
| Pilot measures eligible ordinary-item sales share, outage continuity, stock cases and recovery time | P7 #53 |

P7 records the share of normal trade that this scope can preserve; P0 sets no invented numerical
success target. If continuity is inadequate, improve backup connectivity and bring scope findings
to Shafeek. Do not quietly expand offline prescription dispensing or general management actions.
