# Desktop POS v1 contract — P0 (#46)

Status: snapshot architecture and product decisions D1–D14, including staff follow-ups D7a/D7b,
reviewed and agreed with Shafeek on 2026-10-20. See [POS_V1_REVIEW.md](POS_V1_REVIEW.md) for
the approved outcomes, changes to initial proposals and user comments.
Decision 10 was amended and approved on 2026-10-21: remote online management/authorization,
with local enrolled physical execution. The revised matrix below supersedes its original wording.
Per Shafeek's direction, treat Shafeek as the developer; staffing and work allocation are managed
by Shafeek. No second-developer ownership sign-off is required in this workflow.
Baseline: develop `4a2fa3ad8440b2fea462c09b766efee2035295d3`, reviewed 2026-10-19.
Tracking: https://github.com/ShafeekSaleem/PharmaCeylon/issues/46.

This document and `packages/shared/src/terminal-contracts.ts` define the contract for
P1–P7. They do not enable offline sales, enforce terminal authentication on existing
routes, or change the Prisma schema. Existing API DTOs remain unchanged until the
relevant implementation epic. This supersedes both the original multi-offline-counter/hub
proposal and P0's initial preallocated-stock proposal. Epic #46 tracks this approved contract;
dependent epic descriptions must use the same decisions when their implementation begins.

## Scope decisions

- Approved: all online counters share the full normal available balance. No offline reservation,
  percentage partition or manual stock arming, before or during an outage.
- Approved: during online enrollment, at most one terminal per branch is designated offline-capable.
  A branch may have none until nomination. Nomination and replacement require
  an online, authorized, audited transaction with a branch-level uniqueness constraint.
  Approved D13 (2026-10-20): the owner may assign/change designation and explicitly delegate this
  ability to selected managers for their branch. Managers do not receive it automatically. Every
  assignment/change requires internet and verified local attendance, including for owners.
- Desktop terminal identity binds tenant, branch, device enrollment and signing key.
  Branch is immutable for the enrollment. Moving a device requires revocation and new
  enrollment, not changing a header. Register identifies the counter, till the cash drawer,
  work session the staff shift. A grant is signed offline permission, not a stock hold.
  D7 requires staff switching while offline. Each sale retains its actual staff/session identity;
  switching must not reset terminal stock usage, outage time or permission expiry.
  The grant binds the register/till and lists `authorizedStaff`, without preassigning future shift IDs.
  Approved D7a (2026-10-20): branch staff prepared for offline access on this terminal while online
  can sign in with their own previously configured offline PIN, even if they were not the original
  cashier. New accounts, permissions and PIN setup/reset require internet.
  Approved D7b (2026-10-20): staff may close the current shift and open the next one offline on
  the same till, recording outgoing closing cash and incoming opening cash separately. Each shift
  keeps its own identity/sales and remains marked not yet synced until server acknowledgement.
- Revised D10 (approved by Shafeek, 2026-10-21): authorized online management and
  approvals can use web/mobile or remote desktop; physical branch execution requires the
  enrolled desktop used locally at the correct branch. See the action matrix below.
  This supersedes the original blanket desktop-only rule. P1/P2/P6 implement enforcement;
  these contracts do not claim today's routes already enforce it.
- Approved D2 (2026-10-20): offline checkout permits ordinary, non-prescription, non-controlled products only.
  The API excludes ineligible products from the offline stock snapshot; clients cannot declare eligibility.
  Returns, voids/cancellations of completed sales, refunds, receipts, transfers, adjustments,
  stocktakes, approvals, prescriptions and controlled dispensing require online authorization.
  Editing/removing items from an unfinished local cart remains allowed. Payment methods and
  credit are approved in D5; saved prices and no offline discounts are approved in D6.
  D7b additionally permits the shift-opening/closing records described below; this does not
  authorize refunds, arbitrary cash movements or stock adjustments.
- Approved D5 (2026-10-20): cash and recording an independently approved external card-terminal payment,
  including cash/card split payments whose net amounts sum exactly to the sale total.
  This is not offline card authorization. No PAN, CVV or track data enters the journal.
  External-card recording is disabled unless the signed grant permits it; retain provider
  reference, approval code and approval timestamp. Mobile-wallet and credit are excluded.
- Approved D3 (2026-10-20): grants last no more than 24 hours from the last successful online
  permission renewal (issuance), never extendable offline. Refresh is automatic while connected;
  show the expiry time to staff. The outage may start with less than 24 hours remaining. At expiry,
  stop new offline sales until online renewal; preserve all saved sales for later synchronization.
- Approved D9 (2026-10-20): the 24-hour permission expiry is the only additional offline selling
  limit; there are no offline sale-count, per-sale-value or total-sales-value caps and no branch
  cap configuration. Stock/snapshot, opening hours, authorized staff, allowed operations/payment
  methods, exact integer money and other agreed validation still apply.
- Approved D4 (2026-10-20): the saved stock must be no more than 15 minutes old at the original
  outage start. Refresh snapshots automatically while online. If older, offline sales cannot
  start until a successful sync installs fresh stock. Check age once at outage start; this is
  not a 15-minute offline selling limit. The separate 24-hour permission expiry still applies.
  Restarts and connection flaps cannot reset the saved original outage time.
- Approved D6 (2026-10-20): use saved snapshot prices and tax settings, with no offline discounts
  or manual price overrides. Sync preserves completed receipts and amounts actually charged;
  later catalog changes apply only after a fresh sync. No customer credit is separately approved in D5.
  Wire representation currently uses tax-exclusive LKR minor units; tax is rounded
  half-up per line. API adapters must explicitly convert existing Decimal/major-unit values
  and reject inexact conversions. Quantities are positive integer base units, never packs.
  Adapters must verify parity with existing sales tax/price semantics before rollout; D6 approves
  preserving saved pricing, not changing the pharmacy's tax policy.

## Snapshot availability and automatic offline mode

Normal central availability remains on-hand minus quarantined minus existing business
reservations (such as approved transfers). Offline enrollment, grant/snapshot refresh,
connection loss and revocation create **no StockReservation rows** and do not reduce that balance.
Example: 100 available units → all three connected counters can sell from the same 100.

While connected, the nominated terminal automatically downloads and atomically installs a
server-signed `BranchStockSnapshot`: device/branch identity, snapshot ID/version, generation
time, journal inclusion watermark and eligible product/batch available quantities, prices,
tax and expiry cutoffs. It is a last-known view, not a guarantee of current stock. Zero balances
and an empty eligible catalog are valid snapshots but authorize no additional quantities.

When connectivity is lost, only that terminal automatically enters offline selling if its
cached permission/session, trusted clock and snapshot-age check pass. Other disconnected
counters stop operational writes. Counters still connected to the API keep working normally;
the offline device cannot reliably determine whether the whole branch is disconnected.
No outage-time percentage split and no branch hub are part of v1.

Freeze the verified snapshot ID/version and an `offlineSessionId`/start time for the outage.
Local remaining stock is snapshot availability minus durable consumption since that snapshot.
Include this device's confirmed online sales that the snapshot watermark does not yet include;
otherwise an online sale immediately before disconnect could be sold again locally. Persist
local sale, quantity use, counters and signed journal atomically. Unknown batches, expired stock
and quantities above that local remaining balance are blocked. No offline stock increases/receipts.

Snapshot freshness is checked at the original outage start; do not restart the outage timer or
reset usage on reboot, connection flaps, staff activity or mere API reachability. Grant expiry
still applies throughout. Resume an outage only from the same durable baseline. On reconnect,
drain/resolve outstanding commands before atomically installing a new snapshot and rebasing usage.
Snapshot creation must read stock and the device's accepted sequence/hash consistently in one
database view. Posted effects through the watermark must be included. Under approved D1,
all batches whose accepted sale still has pending stock posting carry `stockReviewRequired`
and cannot be sold from a fresh snapshot; advancing the watermark must never make those units
sellable again. Keep that block until the case is resolved and its stock effects are accounted for.
Sale counts/values remain available for reporting, not offline caps. Permission renewal requires
authoritative settlement of prior commands; never duplicate a sale or reset stock usage during refresh.

On an ambiguous online checkout timeout, keep the original command unresolved. Do not resubmit
the same sale offline under a new ID. Resolve its durable receipt first; this may block that cart,
not unrelated new carts that have a valid local balance.

During a partial outage, another counter may sell from the same stock. Example: snapshot says
10; an online counter sells 7; the offline counter sells 5. The later stock reconciliation has
a 2-unit discrepancy. Single offline designation does not prevent this. Full-branch outages also
have an in-flight sale window. The user chose snapshot continuity with this limitation explained;
the treatment of stock conflicts below was approved in decision D1 on 2026-10-20.

Quarantine, recalls, price changes, transfers and stocktakes made after snapshot capture cannot
instantly reach a disconnected device. Their central operations proceed normally and their
audit/history must be available during reconciliation. Never label offline snapshot stock as
reserved, guaranteed, or centrally current. Proposed displays show last successful sync time,
offline local balance, pending sales and reconciliation cases; online stock has no offline-reserved column.

## State machine and evidence

| From | Event / required evidence | To |
| --- | --- | --- |
| nominated/ready | Automatic online refresh; current unique nomination, valid staff permission, verified consistent snapshot and no unresolved journal rebase | ready |
| ready | Connection lost; valid permission, trusted clock and snapshot-age-at-outage check | offline |
| offline | Connectivity restored | draining |
| ready | Grant expires before outage | nominated |
| offline | Grant expires | draining |
| ready/offline | Explicit drain requested | draining |
| draining | Journal durably accepted, uncertain submissions resolved, fresh stock and review blocks installed; safe to resume | nominated |
| any | Authorized revocation or loss report | revoked |

`revoked` is terminal for that enrollment. Ordinary online counters have no offline
state/grant. No transition newly nominates or enables a device while disconnected. `ready` is
automatic preparation, never a manual stock-reserve action. API reachability
alone is insufficient: authentication and a successful synchronization cycle are required
to resume online operation. Draining/revoked/expired devices cannot create new offline sales.

Approved D12 (2026-10-20): when connectivity returns, pause new checkouts on the nominated
terminal and show "Synchronizing". Upload saved sales/shift records and resolve uncertain
submissions before installing a fresh consistent snapshot and resuming online checkout.
Other connected counters continue normally. A committed sale with a durable discrepancy case
counts as accepted: it need not wait for manager settlement, but its batch sale blocks must be
installed before resuming. Incomplete/failed synchronization keeps this terminal paused with a
clear issue; a network flap must not reset its stock baseline or start a new offline timer.
`OnlineCheckoutResumeEvidence` / `mayResumeOnlineCheckout` model the required trusted evidence;
the lifecycle reducer alone is not proof that synchronization finished.

The reducer validates transition shape only. P1/P3/P5 validate evidence and persist
transitions atomically. Server revocation is a desired state until delivered to an offline
terminal; it does not retroactively erase sales. Revoked-device recovery may upload its
journal through a restricted authenticated recovery endpoint but cannot perform new writes.

There is no offline stock hold to release when a grant expires or a terminal is lost.
The journal must still be retained and discrepancies reviewed. Approved D11 (2026-10-20):
the old device must no longer be able to sell offline (confirmed local disable or old grant
expiry with trusted-clock protection) and its journal must be resolved, or its loss reviewed.
A server revoked flag alone cannot stop a disconnected old device. Replacement can operate
online while waiting; do not give it offline permission that overlaps the old usable grant.
Never copy old keys, grants or journal identity to a replacement. Late recovered journals
are checked against any prior physical-count settlement to avoid double deductions.
For a lost terminal, enabling replacement offline may require waiting out the remainder of the
old 24-hour permission. Online enrollment and authorized online operation need not wait for that
offline clearance. `mayEnableOfflineReplacement` models the approved offline-only gate.

Approved D13 delegation is per selected manager user and target branch, not a grant to the shared
manager role. Only the owner may create/revoke that delegation; a manager cannot delegate it onward
or obtain it by editing general role permissions. `OfflineTerminalDelegation` preserves owner,
manager, branch and revocation evidence. Validate current manager assignment and live delegation
online, rather than accepting a client role flag or stale cached permission. Staff membership,
tenant/branch access and local-attendance checks still apply.

`OfflineTerminalAssignment` identifies the target enrollment, expected nomination version and
reason; derive its branch from immutable enrollment identity. Atomically enforce the version and
single designation, preserve old/new terminal and actor/delegation audit evidence, and apply D11's
replacement clearance before issuing offline permission. The target may be newly enrolling;
P2's enrollment flow must establish trusted identity and local attendance without requiring an
already-enrolled device as a bootstrap prerequisite. `mayManageOfflineTerminal` consumes trusted
server-derived facts only; it is not an implemented API guard or permission-catalog migration.

## Signed wire envelopes

Shared types define `Signed<OfflineGrant>`, `Signed<BranchStockSnapshot>`, `Signed<OfflineSaleCommand>` and
`Signed<OnlineTerminalCommand<T>>`. Server keys sign grants/acknowledgements; enrolled
device keys sign commands. Server keys also sign stock snapshots. Key IDs resolve to pinned, purpose-specific keys and cannot
select an arbitrary caller-provided public key. Envelope key ID must match the enrolled
key for commands; a grant's signing key is a server key, distinct from its device identity.

Signature suite: Ed25519; SHA-256 lowercase hexadecimal command digests; base64url signatures
without padding. `terminalSigningText` defines the exact bytes before UTF-8 encoding:
`PharmaCeylon:terminal:v1:<purpose>\n` plus canonical JSON. Purpose is `grant`, `command`
or `sync_response`; stock views use `snapshot`. Canonical JSON sorts object keys in UTF-16 code-unit order, preserves
array order, uses JSON string escaping, permits only null/booleans/strings/safe integers,
and rejects undefined, non-plain objects, sparse arrays and non-finite/fractional numbers.
No Unicode normalization. Hash the same domain-prefixed bytes that are signed.

P1/P3/P4 must reject unknown wire fields, invalid/empty IDs, excessive lengths/counts,
malformed digests/signatures and wrong discriminators **before** signature/policy checks.
The exported typed policy functions are not a JSON parser, cryptographic verifier or
authorization boundary. Use separate schema validators at API and Electron IPC boundaries.
The renderer never holds the private key or supplies trusted usage/clock information.
Approved D7a: the trusted main process authenticates the prepared staff member with the personal
offline PIN before activating their authorized session. Merely selecting a user ID is insufficient.
Keep a salted slow PIN verifier in protected local storage; never put the PIN or verifier in grants,
sale commands, sign-in events, logs or sync requests. Apply durable failed-attempt throttling; restarting
must not clear it. Changing permissions or preparing/resetting a PIN needs online authorization.
Grant/session authorizations identify staff authorization ID and credential version; local prepared
credentials must match that version. Switching staff does not extend the terminal grant or confer
new permissions. Server role/PIN revocations cannot instantly reach an offline device; its last
verified bounded authorization remains the offline limit until updated or expired.

`OfflineStaffSignIn` is device-signed evidence produced only after successful local authentication,
binding device/branch, staff/session, grant, authorization ID, credential version and time. Each sale
references that sign-in ID. Sync supplies the signed sign-in evidence and verifies the grant/device
binding; it never uploads or rechecks the raw PIN. The policy helper consumes trusted verified evidence;
it is not a PIN verifier. P2/P4 must implement local verification, durable active-session handling,
attempt throttling and sign-in/sign-out audit.

## Offline shift handover — approved D7b

Staff authorizations are prepared online for the fixed register/till; future work-session IDs
are generated durably on the nominated terminal. They do not require an online-created session.
Only one work session may be open on the till at a time. A resumed shift that began online is
imported with its immutable identity, opening cash and locally maintained expected cash.

`shift_close` records the outgoing staff member, closing cash count and locally calculated expected
cash/variance. Store its immutable summary and signed journal command in the same local transaction
that closes the shift. Reject further sales on that closed shift. `shift_open` records the incoming
prepared staff member's new work-session ID, opening cash count and preceding closed-shift ID.
It requires personal-PIN authentication, no already-open shift and an unused session ID.
Do not erase a cash variance or force the next opening count to equal the old expected count;
preserve both staff entries for audit. These are counted balances, not permission to create cash.

Both events use the same durable command-ID/sequence/hash chain as offline sales. Sync replays
open → sales → close in order, persists shift receipts exactly once and preserves cashier attribution.
Shift acknowledgements identify `workSessionId`; sale acknowledgements identify `saleId` and stock
posting outcome. An unsynced close must not block the next locally valid shift: that is the point
of offline handover. Label shift totals and cash counts as not yet synced until acknowledged.
Local durability is still required before staff see a successful close/open.

Shift transitions preserve the original outage/snapshot baseline and terminal-wide stock usage.
Opening a shift cannot renew permissions or extend their expiry. Approved D9 removes the previously
proposed sale-count/value caps. Approved D8 permits counting cash
and closing the existing shift outside sales hours, but does not reopen selling or authorize an
after-hours selling shift. The existing grant expiry still governs authorization; no fresh snapshot is required solely for a handover
inside an already valid outage. `offlineShiftTransition` is a pure lifecycle fixture: callers verify
signatures, the active outage, ordered journal, credential evidence and trusted local cash totals,
then persist all effects atomically. It does not implement the durable till or PIN store.
Remote-session status is determined in the trusted desktop process and bound to attestation;
a request header claiming to be local is not evidence. P2/P7 must test Windows session detection.

Online local-execution commands bind method/route, exact body, identity/session, a short server-defined
validity window and a one-use server nonce bound to that digest. Staff authority and current
domain validation are still required. Transport retries reuse command ID and identical bytes.
Offline sale commands additionally bind grant/nomination and snapshot versions, durable outage ID/start,
occurrence time, monotonically
increasing sequence and previous command digest. Sequence starts at 1 per enrollment and
never resets with a staff session or grant. Shift events share that sequence and grant/outage context.
Persist signed bytes before reporting success.

All counters, quantities, timestamps and money must fit JavaScript safe integers. Reject
overflow in intermediate arithmetic; perform tax multiplication using exact integer arithmetic.
Prices/tax/eligibility come from the verified signed snapshot rather than renderer claims.
Approved D6 preserves these last-known prices/tax on completed offline sales without discounts
or overrides. Replay/sync must validate the original signed snapshot rather than current prices.

## Sync, idempotency and errors

Unique keys: tenant + enrollment + command ID, and tenant + enrollment + sequence.
Retain immutable command digest and original receipt for at least the full journal/recovery
retention period (P5 must set a concrete retention policy before rollout; no TTL deletion that
allows replay). Existing optional user-scoped Idempotency-Key is insufficient for these commands.

Authenticate the submitting device/recovery channel, then check durable receipts before current
grant expiry/session rules. An exact replay returns the original sale/commit receipt even after
expiry; same ID/sequence with different digest or identity returns REPLAY_CONFLICT. New historical
offline sales are validated against authorization at occurrence, signed grant/snapshot, clock
evidence and durable local usage. They are not rejected solely because arrival occurred after
expiry. Suspicious or revoked/lost-device submissions enter review without silently deleting sales.

Approved D1 (2026-10-20): persist an authenticated completed sale/payment exactly once even if current central
stock is insufficient. If stock is sufficient, post the entire stock effect with the sale/receipt
in one transaction. Otherwise persist the sale, receipt and explicit `OfflineStockDiscrepancy`
case in one transaction, mark stock posting `pending_reconciliation` and show its pending quantity
to authorized staff. In the same transaction, block the affected sale batches from further central
sales and mark them `stockReviewRequired` in subsequent snapshots until reviewed;
unrelated stock remains usable. This is a conflict-review block, not advance offline reservation.
Do not partially deduct the sale, clamp quantities, fabricate stock, bypass
StockService's availability checks, silently create negative stock or claim the stock is posted.
Resolution later posts/links the approved stock correction exactly once and audits the reason.
The user approved retaining the sale/payment, manager review and the affected-batch sale pause;
contracts model both receipt outcomes explicitly. The full product review is recorded in POS_V1_REVIEW.md.

Each command has an acknowledgement: committed, duplicate, held or rejected. Held/rejected items
retain the journal for repair/review. Only a signed, identity-matching server
response with command ID/digest and receipt may mark a local item acknowledged. The response
watermark is the highest contiguous durably accepted sequence/hash; it never jumps a gap or held item.
An accepted sale with a durable discrepancy case may advance that watermark, but its stock posting
remains pending. Receipt acceptance is not stock settlement; keep unresolved cases visible and
retain original journal/audit evidence even after installing a fresh baseline.
Keep later items queued until the gap is resolved. A lost HTTP response after commit is recovered
by retrying the same command, yielding `duplicate` and the original receipt, including any pending
case. Receipt plus sale and either all stock effects or a discrepancy case commit together;
local journal, stock use and counters must likewise commit together.

| Error class | HTTP / client handling |
| --- | --- |
| INVALID_COMMAND, UNSUPPORTED_CONTRACT | 400; stop and repair/upgrade; never blindly retry |
| INVALID_SIGNATURE, IDENTITY_MISMATCH | 401; require authenticated recovery |
| TERMINAL_REQUIRED, REMOTE_SESSION_DENIED, TERMINAL_REVOKED, SESSION_INVALID, PHARMACIST_REQUIRED | 403; require authorized action |
| ONLINE_REQUIRED, GRANT_INVALID, GRANT_EXPIRED, SNAPSHOT_INVALID, SNAPSHOT_MISMATCH, SNAPSHOT_STALE, LOCAL_STOCK_EXHAUSTED, OUTSIDE_OPERATING_HOURS, CLOCK_UNTRUSTED, PAYMENT_NOT_ALLOWED | 409; stop new sale; reconnect or correct policy |
| REPLAY_CONFLICT, SEQUENCE_GAP, RECONCILIATION_REQUIRED | 409; retain journal, resolve/review; never change ID to bypass |
| TEMPORARILY_UNAVAILABLE | 503; retry identical command with backoff |

Error payloads include version, stable code, correlation ID and retryable flag. Do not put
patient data, credentials or signed tokens into messages/logs. Partial sync uses per-command
outcomes; a successful HTTP response is not evidence every command committed.

## Hours, clock and pharmacist evidence

Approved D8 (2026-10-20): resolve operating hours in the branch timezone online into signed absolute UTC windows bounded
by the grant. Outside-window work needs an explicit, reasoned, authorized local-hours exception
with approver and bounded interval. Offline terminals may use only an exception already present
in their signed grant; no clock changes, local manager override or self-issued extension. New sales
stop outside those windows. Staff may still count cash and close the existing shift after sales
hours without opening a new selling shift. The separate 24-hour permission expiry still applies.
An hours exception never overrides grant expiry,
batch expiry, local stock bounds, staff permissions or pharmacist requirements.

Trusted time derives from last authenticated server time plus monotonic elapsed time and durable
rollback evidence. Local wall-clock time alone is insufficient. P4 must fail closed on rollback,
unknown elapsed time after restart, or lost trusted state; reconnect before resuming. The policy
fixture accepts trusted time as an input and does not implement OS clock protection.

Approved D14 (2026-10-20): normal restart may resume the same offline session when journal,
stock consumption, staff/shift state and trusted time are safely restored. Preserve the original
grant/version/expiry, outage ID/start, snapshot ID/version and journal sequence/hash. Do not
reapply snapshot freshness using reboot time or grant another 24 hours. The original outage
must already have passed D4's initial freshness check, and all other sale checks still apply.

Journal damage, lost state, clock rollback or inability to prove trusted elapsed time requires
online recovery before new offline sales. Retain all recoverable sales and original evidence;
never silently clear the journal, reset stock or create a new enrollment to hide the problem.
Restore an interrupted synchronization pause as paused under D12; expired/revoked permission
cannot be revived by reboot. `OfflineRestartEvidence` / `offlineRestartDecision` express those
conditions but do not verify disk integrity, implement Windows time protection or perform recovery.
P4/P5 must verify the original/restored boundaries against protected durable state and the signed
grant/snapshot, recover atomic transactions and give staff a clear recovery issue. Local PIN
authentication still applies before a restored staff session can be used.

Controlled/prescription dispensing is online only. Reuse PharmacistApprovalService and AccessService
for live branch permissions/self-approval rules. Persist approver ID, operation digest, reason,
verification time, branch/session and authorization policy version as an approval evidence record;
bind its ID to the online command. `PharmacistEvidence.operationDigest` hashes the operation/body,
identity/session before the evidence ID is attached, avoiding a circular signature dependency.
Never persist a PIN/password in an envelope or grant. A cached
pharmacist identity or prior approval cannot authorize offline dispensing. Clinical verification
and dispensing require the authorized local desktop workflow. Remote managerial approval does
not replace clinical evidence. Managerial workflow approvals follow revised D10 below; D8 still
requires operating-hours extensions to be approved online before an outage.

## Revised D10: remote management, local physical execution

Authorized owners/managers may work online from web/mobile or a remote desktop session,
subject to existing role, branch, amount and self-approval rules. Remote authority is explicit;
a management permission does not authorize branch execution.

| Workflow | Online remote management | Local enrolled terminal execution |
| --- | --- | --- |
| Purchasing | Prepare/edit/issue/review/approve/reject purchase orders; supplier and invoice administration | Confirm actual goods received, batches, quantities and condition; post receiving |
| Transfers | Prepare/review/approve/reject/cancel requests and normal business reservations | Confirm dispatch and destination receipt under the respective branch authority |
| Supplier returns | Prepare/review/approve/reject return requests and commercial credit administration | Confirm goods leaving the branch and post the stock movement |
| Customer returns/refunds | Review the sale, prepare and authorize the return/refund | Inspect returned goods, choose disposition and execute stock/refund effects |
| Adjustments, write-offs, stocktakes | Plan/request/review/approve corrections and review discrepancies | Capture/confirm actual counts or condition and execute adjustment, write-off or quarantine/release |
| Products, prices, suppliers, customer contacts | Manage catalog, pricing, suppliers and administrative contact records | Imports/undo that also create/remove batches or stock require local execution |
| Payments | Record bank payments online with supporting evidence | Actual branch cash collection/payout and till cash movements |
| Prescription/controlled dispensing | Managerial review does not provide clinical sign-off | Qualified clinical verification and dispensing remain local and online |
| Offline-terminal designation | Existing D13 delegation may be administered with permitted settings | Assign/change designation online, locally, audited; D11 replacement checks still apply |

A remote approval may create an ordinary business reservation or commercial commitment.
On-hand stock, physical cash and executed customer refunds do not move merely because approval
was granted. These business reservations can reduce available stock; they are not advance
offline reservations. Snapshot/offline rules D1–D9 and D11–D14 remain unchanged.

Bind approval to tenant/branch, document type/ID, exact version and canonical relevant-content
digest, authorized action, requester, approver, reason/time and policy version. Changes to approved
quantities, batches, prices, amounts, destination or other material content invalidate approval;
the changed document needs fresh approval. At execution, fetch persisted evidence and revalidate
current authorization, document/action binding, existing limits and remaining quantities in the
same transaction as posting. Prevent duplicate execution with command idempotency and domain
limits; do not impose a blanket single-use rule on legitimate partial receipts.

Audit requester, approver and executor separately, with execution terminal/enrollment/work session,
command and timestamps. Preserve the existing branch self-approval policy: approving one's own
request is distinct from executing a request one approved. An authorized on-site manager may
approve and execute in one guided flow where policy permits; retain both records. No mandatory
two-person rule or new approval expiry duration is introduced.

Shared types in `operation-policy.ts` define `OnlineManagementCommand`,
`ManagementApprovalEvidence` and `ApprovalExecutionAttribution`. Management requests use normal
online authentication/CSRF and branch permissions; they need no device key. Signed
`OnlineTerminalCommand.approvalEvidenceId` refers to server-persisted approval when required
(otherwise null); signing covers it along with the exact execution payload. Clinical evidence
remains separately required where applicable.

The pure `onlineOperationAccessError` and `approvalUseError` fixtures specify effect-based
access and approval binding. They are not runtime DTO validators, cryptographic verification,
API guards or database transactions. Added policy outcomes include `PAYMENT_EVIDENCE_REQUIRED`,
`APPROVAL_REQUIRED`, `APPROVAL_INVALID`, `APPROVAL_STALE`, `APPROVAL_EXPIRED` and
`SELF_APPROVAL_DENIED`; adapters must preserve stable actionable outcomes.

Classify complete server-side effects, including nested services, workers and legacy paths.
Mixed endpoints that both approve and post physical effects must be split; until split they
require the stricter local execution context. Neither route prefix/HTTP method, button label nor
client-declared effect is authorization evidence. Owners cannot bypass physical/clinical checks.
Remote management remains online only; it adds no offline approvals or stock operations.

## Delivery dependencies

The [developer integration guide](POS_V1_DEVELOPER_CONTRACT.md) defines API/desktop promises,
component boundaries and verification. Shafeek handles staffing; the dependencies below are technical.

| Deliverable | Technical dependency |
| --- | --- |
| P0 shared contracts, API DTO mapping and fixtures | Approved product decisions and compatible shared interfaces |
| P1 API terminal boundary, permissions, audit and all worker entry points | P0 |
| P2 desktop enrollment, keys, local session detection and staff sessions | P0 |
| P3 consistent signed snapshots, permission refresh and journal watermarks | P1 |
| P4 durable local journal and offline checkout | P2 + P3 |
| P5 reconciliation/revocation/replacement | P3 + P4 |
| P6 online operations and oversight | P1 + P2; snapshot/conflict integration waits for P3/P5 |
| P7 Windows release and branch pilot | P5 + P6; release CI groundwork may start earlier |

Small PRs target develop. Changes to shared fields/invariants require updating fixtures and this
document in the same PR. Do not independently create competing Prisma migrations for shared tables.

- [x] P0 contract types, policy model, mutation inventory and six required scenario fixtures prepared.
- [x] Shafeek chose snapshot v1, one enrolled offline-capable terminal, no advance reservation (2026-10-20).
- [x] Product policies D1–D14 and staff follow-ups D7a/D7b agreed individually in POS_V1_REVIEW.md (2026-10-20).
- [x] Developer coordination clarified: Shafeek is the developer contact and manages allocation;
  the earlier second-developer naming/ownership requirement is withdrawn at Shafeek's direction.

## Validation and limits

Run `npm test -w @pharmaceylon/shared` and `node scripts/pos/check-mutation-inventory.mjs`.
CI runs both. Fixtures cover partial outage, expiry, replay, crash-after-commit receipt recovery,
replacement and loss, plus absence of sale-count/value caps, money, payment, snapshot freshness/baselines,
hours, staff/till lifecycle, restart recovery and identity rules. These are
contract tests, not proof of database atomicity, durable OS recovery or secure Windows enrollment.
P3–P7 must implement real concurrent, crash-injection, crypto/key-storage and restart tests.
