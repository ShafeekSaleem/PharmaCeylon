# POS v1 developer contract and integration guide

Updated per Shafeek's direction on 2026-10-20: treat Shafeek as the developer for this work.
Shafeek manages staffing and allocation. No second developer needs to be named or approve
ownership before implementation can proceed. Product decisions are agreed in
[POS_V1_REVIEW.md](POS_V1_REVIEW.md); this document preserves the technical component contracts
and integration checks, without assigning work to people.

## Component boundaries

P1 implementation status and service integration examples/boundaries are tracked in
[POS_P1_IMPLEMENTATION.md](POS_P1_IMPLEMENTATION.md). MR 2 adds backend terminal trust services
and additive enrollment/session challenge types. Local attendance currently fails closed
pending P2 integration; financial shifts, operational endpoint enforcement and business replay
remain subsequent work. A terminal staff authorization binding is not a posted till shift.

| Component | Technical responsibility |
| --- | --- |
| `packages/shared` | Wire types, error codes, signing encoding and contract fixtures |
| `apps/api/src` | Device/staff authority, operational boundaries, audit, snapshots, sync and reconciliation |
| `apps/api/prisma` | Central schema and a coherent ordered migration history |
| `apps/pos-desktop` main/preload | Key custody, attendance checks, SQLCipher migrations, PIN verification and durable journal |
| `apps/pos-desktop` renderer | Checkout, staff/shift handover, sync/recovery feedback and protected operation screens |
| `apps/web` and `apps/mobile` | Online management, version-bound approvals and oversight; local execution handoff |
| CI/release tooling | API/database integration, Windows packaging, restart resilience and pilot evidence |

## Shared contract implementation must preserve

The normative product rules are in [POS_V1_CONTRACT.md](POS_V1_CONTRACT.md). In particular:

1. Online counters share normal available stock. Offline capability never reserves or divides stock.
2. One offline-capable device per branch, designated online. Signed snapshots are last-known views;
   they do not guarantee current stock. At outage start the saved snapshot must be at most 15 minutes old.
3. Offline permission expires no later than 24 hours after the last successful online renewal.
   There are no offline sale-count, per-sale amount or cumulative amount caps.
4. Ordinary non-prescription/non-controlled sales only, plus the approved shift lifecycle. Offline
   payments are cash or separately approved external card, including split tender. No wallet/credit,
   discounts, price overrides, refunds, completed-sale voids or stock operations.
5. Prepared branch staff authenticate using their own preconfigured PIN. They may close/open shifts
   offline on the same till. Keep separate staff/shift attribution and cash counts without resetting
   stock, original outage, expiry or command sequence. New users/rights/PIN resets require internet.
6. Revised D8: mandatory time restrictions remain hard limits. Outside routine hours, prepared
   managers may record a bounded local acknowledgement; it never extends grant expiry. Existing
   shift cash count/close remains allowed outside selling hours with valid permission.
7. On reconnect, the nominated terminal pauses new checkouts until the journal is accepted, uncertain
   submissions resolved and fresh stock/review blocks installed. Other online counters continue.
8. Completed offline sales/payments are retained exactly once. A stock shortage creates an explicit
   case and pauses sales from the affected batches. Never delete the sale, fabricate stock or silently
   bypass StockService to force a negative balance. Accepted cases do not block unrelated stock.
9. Lost-device replacement works online immediately after enrollment. Its offline permission waits
   for old-device cutoff and recovery/review of missing sales. Server revocation alone is not cutoff.
10. Revised D10 (2026-10-21): online remote management/approvals and catalog/price/supplier/contact
    edits are permitted with branch authority. Physical stock, branch cash, executed refunds and
    clinical dispensing require the locally used enrolled desktop, including for owners. Bank payment
    recording requires evidence. Revised D13 permits owner/delegated-manager authorization remotely
    online, followed by authorized local target activation. Keep D11 clearance and unique nomination.
11. Restart may resume only the same verified durable state. Clock/journal uncertainty requires
    online recovery; preserve recoverable data. Never reset the 24-hour period or erase a sync pause.

## Management approval and execution interface

Use the revised D10 action matrix in [POS_V1_CONTRACT.md](POS_V1_CONTRACT.md).
`OnlineManagementCommand` uses normal online user auth/CSRF and branch permissions.
`ManagementApprovalEvidence` binds the current document version/digest and exact action.
Signed `OnlineTerminalCommand` carries `approvalEvidenceId` (null where not required).
Resolve approval from the server, revalidate authority/material content and domain limits, and
commit execution, idempotency receipt and accountable audit atomically. Never trust a client effect label.

Retain separate requester/approver/executor attribution with terminal/work session for execution.
Existing self-request approval rules apply; an approver may also execute where authorized.
Remote approval may create normal reservations/commitments, but cannot automatically post
physical stock, branch cash or an executed refund. Split mixed legacy handlers; until split,
apply local execution restrictions. Imports/workers inherit the complete effect requirements.
Catalog-only processing may run from authorized remote management; stock-bearing import/undo
requires verified local execution authority. D8 business-hours acknowledgement and prepared-manager assisted shift closure are narrow local
exceptions, not general offline management. Remote management remains online only.

## Operational-readiness contract

[POS_V1_OPERATIONAL_READINESS.md](POS_V1_OPERATIONAL_READINESS.md) defines the approved scenarios
and acceptance mapping for P1–P7. Shared `pos-resilience-contracts.ts` types expose card-attempt
evidence/recovery actions, append-only incidents, readiness issues, drain-start facts and count-based
settlement evidence. `OfflineSupportRecord` sync uses independent immutable record IDs/digests and
signed acknowledgements, without consuming sale/shift sequence numbers. Resolve evidence dependencies
before command acceptance; held records are not accepted and cannot be discarded.

Separate assignment authorization from activation in APIs and UI; audit both actors. Prepare explicit
manager capabilities online; never infer them from a renderer role. Persist after-hours acknowledgement
before dependent commands. Assisted closure retains original cashier/session and actual counting manager.
No raw PIN/card credentials are serialized in grants, commands, support records or logs.

Preserve payment intent/draft before charging; resolve unknown outcomes before another charge.
Keep original charged totals; explicitly review discounted carts before offline tender. Nonfinancial
incident notes add no refund/stock/cash authority. Show readiness and pending money before an outage.
Reconnection waits for stable authenticated connectivity and a durably quiesced checkout; recovery
uploads can resolve uncertainty during drain. Resume includes accepted support evidence and resolved
payment attempts, alongside the original journal/fresh-stock/review-block gates.

Approval material versions exclude notes and ordinary partial-execution counters. Material edits
still invalidate approval; remaining quantities/limits and idempotency apply transactionally. Stock
resolution needs timeline/count evidence and existing-settlement linkage, not a blind approve button.

These are unreleased v1 contract amendments. New grant manager-action/mandatory-hours fields and
command acknowledgement/assistance fields are explicit; do not default missing fields into authority.
P1/P2/P3 generate/parse the same amended wire schema and policy version; no production schema is
migrated here. Runtime DTOs reject unknown/missing evidence. Existing v1 snapshots remain last-known.

## API promises to the desktop

- Publish strict runtime DTO validation corresponding to the shared types. Reject unknown fields,
  invalid IDs/versions/signatures and unsafe numeric amounts. Validate tenant/branch from enrolled
  identity, current staff authority and trusted device/session evidence; headers are not proof.
- Provide a signed offline grant for the fixed device/register/till and prepared staff authorizations.
  Grant expiry, nomination and credential versions must be unambiguous. Do not require future
  work-session IDs to be created online before an offline handover.
- Produce stock/catalog snapshots and the accepted journal watermark from one consistent database
  view. Include posted effects through that watermark and block batches with pending stock posting.
- Verify device signatures, prepared-staff sign-in evidence and ordered enrollment-wide journal
  sequences. Unique command ID and sequence identities must prevent concurrent duplicate effects.
- Persist each sale/receipt plus either all stock effects or an explicit discrepancy case atomically.
  Preserve case/block state and historical prices. Persist shift changes/receipts exactly once too.
- Return signed, identity-bound per-command acknowledgements and a contiguous accepted watermark.
  Exact retries return the original resource and outcome, even after permission expiry. Conflicts
  and held items never silently advance the watermark or discard the desktop's journal.
- Implement audited resolution and restricted recovery uploads for revoked/lost devices. Recovered
  late journals must not double-deduct stock already covered by a physical-count settlement.
- Enforce the operational boundary across legacy routes, imports/undo, workers and internal service
  entry points identified in [POS_OPERATIONAL_MUTATIONS.md](POS_OPERATIONAL_MUTATIONS.md).

## Desktop promises to the API

- Keep signing keys, prepared PIN verifiers, trusted time, journal and stock consumption in the trusted
  main process/protected local store. Renderer inputs cannot establish identity, attendance, time,
  prior cash totals or successful PIN verification. Never sync/log PINs or verifiers.
- Verify server signatures and purpose/key bindings before accepting permissions, snapshots or sync
  receipts. Use the exact `terminalSigningText` encoding and shared integer representations.
- Atomically record each offline sale/shift command, sequence/hash, local stock/cash changes and
  staff attribution before reporting success. Commands are immutable; retries reuse identical IDs/bytes.
- Freeze the original outage/snapshot boundary. Deduct local consumption not yet reflected in its
  watermark, including confirmed online sales after that snapshot. Never reset remaining stock on
  staff change, handover, reboot, API probe success or an incomplete synchronization.
- Require verified local attendance and individual prepared-staff authentication. Persist failed-PIN
  attempt throttling and staff/shift events. Opening the next shift must work without an online call.
- Keep exactly one active till shift and immutable cash-count/variance evidence. Sales require the
  matching active work session. Signed open/sale/close events use one enrollment-wide journal chain.
- Present offline mode, last sync, permission expiry, not-yet-synced shifts/sales and recovery cases
  clearly. A reachable API alone is not proof that the terminal is ready to resume online checkout.
- Distinguish app restart from OS reboot/power loss; prove protected time continuity across each
  supported scenario before offline rollout. Same-boot monotonic evidence is insufficient after reboot.
  Test suspend/resume, downtime and rollback; surface unsupported recovery before launch.
- Recover only verified unchanged state after restart. When recovery cannot prove it safe, retain
  evidence and request online recovery; do not create a fresh grant, enrollment or outage to bypass it.

## Handoffs and delivery order

| Gate | Backend interface | Desktop interface | Integration evidence |
| --- | --- | --- | --- |
| P0 → P1/P2 | Shared types, fixtures, mutation map and DTO mapping | Compatible field meaning, encoding, trusted inputs and local-store design | Product decisions recorded; implement against the shared fixtures |
| P1/P2 → P3 | Device/staff authority and audited write boundary | Enrollment, key custody, attendance detection, prepared staff/PIN flow | Online multi-counter checkout; remote management allowed, physical execution denied remotely |
| P3 → P4 | Signed coherent snapshots/grants and replay-safe protocol | SQLCipher journal, trusted-clock persistence and verified snapshot installation | No reservation side effects; freshness/expiry boundaries agree |
| P4 → P5 | Sync acceptance/receipts and discrepancy persistence | Durable offline sales, PIN staff switching and cash-count handovers | Crash/timeout retries, ordered journal and closed-shift restrictions |
| P5/P6 → P7 | Reconciliation, replacement, oversight and protected online operations | Recovery UI, desktop operations and Windows packaging | Integrated resilience checks and recorded branch-pilot results |

P1 and P2 can proceed independently from the agreed P0 product contract. P4 requires both P2
and P3; P5 requires P3/P4. P6 includes API/web and desktop integration, with snapshot/status
integration waiting for P3/P5. Windows CI groundwork can begin early; final pilot waits for
P5/P6. These are technical dependencies, not staffing or additional human-approval gates.

## Change and review rules

- Small branches/PRs target `develop`. Shared fields, units, signature encoding, errors or recovery
  invariants change through a P0 contract update with fixtures and docs in the same PR. Validate
  compatibility before consumers depend on it; avoid merging incompatible drafts.
- Maintain coherent central Prisma and local SQLCipher migration histories. Update the wire contract
  before dependent schema/consumer changes and avoid competing migrations for the same shared tables.
- Review identity, device authorization, journal replay, stock/money atomicity, lost-device recovery
  and migrations as part of engineering verification. Staffing and reviewer allocation belong to Shafeek.
- Current policy fixtures are shared reference behaviour, not proof that runtime enforcement exists.
  P1–P7 add meaningful API/database/OS integration tests for their actual implementation.
- API/desktop adapters must prove money, tax and price parity with existing sales behaviour. Product
  approval of saved prices does not authorize a new tax policy. Agree DTO conversions before checkout integration.

## Implementation verification

- Shared types, signing encoding, runtime DTO validation and consumers remain compatible.
- Positive tests allow remote branch-authorized management and normal reservations; negative tests
  block remote physical effects, mixed-handler bypasses, stale approvals and wrong-branch actions.
- Test existing self-approval settings, separate actor records, material-edit invalidation and
  bank-payment evidence without adding general offline approvals or a mandatory two-person rule.
- Run the scenario matrix for payment crash/retry, after-hours mandatory restrictions, remote
  authorization/local activation, assisted handover, support-record retries and physical-count settlement.
- Test supported session-detection coverage and document its limits; named confirmation/audit still apply.
- Pilot evidence measures eligible ordinary-item trade and outage continuity before expanding scope.
- Central/local migrations preserve journal, snapshot, staff/shift and reconciliation evidence.
- API/database/desktop integration tests verify the relevant contract scenarios as each epic is implemented.
- Preserve the approved product decisions and report material implementation findings to Shafeek.

Existing verification commands: `npm test -w @pharmaceylon/shared` and
`node scripts/pos/check-mutation-inventory.mjs`. These run in CI. This proposal adds no runtime
permissions or schema changes. There is no outstanding staffing or second-developer ownership sign-off.
