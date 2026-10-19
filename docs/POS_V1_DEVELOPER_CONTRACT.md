# POS v1 developer contract and ownership — review proposal

Prepared for Shafeek's review on 2026-10-20. Product decisions are agreed in
[POS_V1_REVIEW.md](POS_V1_REVIEW.md); this document proposes the engineering ownership and
handoffs. The second developer's name and both developers' engineering acceptance remain open.
No ownership acceptance is inferred from the completed product walkthrough.

## Proposed owners

| Area | Primary owner | Required reviewer |
| --- | --- | --- |
| Shared wire contracts, error codes and contract fixtures (`packages/shared`) | Shafeek | Desktop developer |
| API authentication/permissions/audit, service and worker boundaries (`apps/api/src`) | Shafeek | Desktop developer for device/sync trust boundaries |
| All Prisma schema changes and migrations (`apps/api/prisma`) | Shafeek | Desktop developer for contract implications |
| Server snapshots, signed permissions, journal acceptance, stock and financial reconciliation | Shafeek | Desktop developer |
| Electron main/preload/renderer, local SQLCipher migrations, credentials and journal (`apps/pos-desktop`) | Desktop developer — name to confirm | Shafeek |
| Desktop online/offline checkout, staff PIN sign-in and shift/till handover | Desktop developer | Shafeek |
| Web oversight/read-only changes, desktop handoff and mobile API boundary | Shafeek | Desktop developer for user-flow integration |
| API/web CI and server deployment groundwork | Shafeek | Desktop developer |
| Windows CI, packaging, signing, update/restart and local resilience tests | Desktop developer | Shafeek |
| Integrated recovery scenarios and branch pilot | Both, with responsibilities above | Joint review; pilot acceptance by Shafeek |

Primary owner implements and maintains that area; the reviewer checks its interface and failure
behaviour. This is a proposed split, not a requirement to use particular tools or work in parallel.
Avoid assigning simultaneous full-time epics to the same person. Supporting another owner's area
is allowed after agreeing the change; ownership is meant to prevent competing implementations.

## Shared contract both developers must preserve

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
6. Saved opening hours and extensions approved online govern selling. Counting cash and closing the
   existing shift after sales hours remain allowed, subject to valid permission.
7. On reconnect, the nominated terminal pauses new checkouts until the journal is accepted, uncertain
   submissions resolved and fresh stock/review blocks installed. Other online counters continue.
8. Completed offline sales/payments are retained exactly once. A stock shortage creates an explicit
   case and pauses sales from the affected batches. Never delete the sale, fabricate stock or silently
   bypass StockService to force a negative balance. Accepted cases do not block unrelated stock.
9. Lost-device replacement works online immediately after enrollment. Its offline permission waits
   for old-device cutoff and recovery/review of missing sales. Server revocation alone is not cutoff.
10. Operational changes require the locally used enrolled desktop, including for owners. Owner may
    explicitly delegate terminal designation to selected branch managers; no automatic manager grant.
11. Restart may resume only the same verified durable state. Clock/journal uncertainty requires
    online recovery; preserve recoverable data. Never reset the 24-hour period or erase a sync pause.

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
- Recover only verified unchanged state after restart. When recovery cannot prove it safe, retain
  evidence and request online recovery; do not create a fresh grant, enrollment or outage to bypass it.

## Handoffs and delivery order

| Gate | Backend handoff (Shafeek) | Desktop handoff (desktop developer) | Joint evidence |
| --- | --- | --- | --- |
| P0 → P1/P2 | Shared types, fixtures, mutation map and proposed DTO mapping | Review field meaning, encoding, trusted inputs and local-store implications | Both accept fixtures and ownership before dependent shared schema changes |
| P1/P2 → P3 | Device/staff authority and audited write boundary | Enrollment, key custody, attendance detection, prepared staff/PIN flow | Enrolled online multi-counter checkout; remote/browser writes denied |
| P3 → P4 | Signed coherent snapshots/grants and replay-safe protocol | SQLCipher journal, trusted-clock persistence and verified snapshot installation | No reservation side effects; freshness/expiry boundaries agree |
| P4 → P5 | Sync acceptance/receipts and discrepancy persistence | Durable offline sales, PIN staff switching and cash-count handovers | Crash/timeout retries, ordered journal and closed-shift restrictions |
| P5/P6 → P7 | Reconciliation, replacement, oversight and protected online operations | Recovery UI, desktop operations and Windows packaging | Joint resilience checks and recorded branch-pilot results |

P1 and P2 can proceed independently after the P0 agreement. P4 requires both P2 and P3.
P5 requires P3/P4. P6 splits API/web work to Shafeek and desktop screens to the desktop developer;
allocation of actual capacity is agreed when starting P6. Snapshot/status integration waits for
P3/P5. Windows CI groundwork can begin early; final pilot waits for P5/P6.

## Change and review rules

- Small branches/PRs target `develop`. Shared fields, units, signature encoding, errors or recovery
  invariants change through a P0 contract update with fixtures and docs in the same PR; both developers
  review the interface before consumers depend on it. Breaking drafts are coordinated before merge.
- Shafeek is the single owner of shared Prisma migrations. The desktop developer owns local SQLCipher
  migrations. Agree the wire change first; do not independently introduce competing shared migrations.
- Cross-review identity, device authorization, journal replay, stock/money atomicity, lost-device
  recovery and migration changes. Do not mark another developer's review accepted on their behalf.
- Current policy fixtures are shared reference behaviour, not proof that runtime enforcement exists.
  P1–P7 add meaningful API/database/OS integration tests for their actual implementation.
- API/desktop adapters must prove money, tax and price parity with existing sales behaviour. Product
  approval of saved prices does not authorize a new tax policy. Agree DTO conversions before checkout integration.

## Acceptance for this engineering review

- [ ] Shafeek accepts or edits the proposed area/epic ownership split.
- [ ] Desktop developer is named and accepts their responsibilities.
- [ ] Both developers accept shared field semantics, signing encoding, ordered sync outcomes and fixtures.
- [ ] Both agree API/local-migration ownership and handoffs before dependent schema changes.

Existing verification commands: `npm test -w @pharmaceylon/shared` and
`node scripts/pos/check-mutation-inventory.mjs`. These run in CI. This proposal adds no runtime
permissions or schema changes and does not count as either developer's acceptance.
