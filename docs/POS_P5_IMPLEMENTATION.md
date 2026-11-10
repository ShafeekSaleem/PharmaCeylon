# P5 safe reconciliation — implementation status

Epic P5 [#51](https://github.com/ShafeekSaleem/PharmaCeylon/issues/51). Wire details are in
[API_CONTRACT.md](API_CONTRACT.md#offline-journal-sync-p5-51); product rules stay in
[POS_V1_CONTRACT.md](POS_V1_CONTRACT.md) ("Sync, idempotency and errors", D1, D7b) and
[POS_V1_REVIEW.md](POS_V1_REVIEW.md). P5 is delivered in slices; the epic's checkboxes stay open
until each slice and P4's real journals (#50) are in.

## Slice 1 — server-side offline journal intake (built)

| Area | What exists |
| --- | --- |
| Upload | `POST /terminals/offline-journal/sync`: `SyncRequest` in, server-signed `SyncResponse` (`sync_response`) out. Uploader live at the branch with `terminal.execute` (a PIN-opened counter login only for its own enrollment); every sign-in and command verified against the enrollment's pinned key, or the whole upload is refused |
| Receipts and watermark | One `terminal_command_receipt` per accepted command (`offline_sequence`, digest, signed envelope, `CommittedCommandReceipt` result), accepted only at head + 1 with `previousCommandHash` = head digest, under a per-enrollment journal lock. Exact replays return the original receipt, even after grant expiry or revocation; anything else under that ID or sequence is `REPLAY_CONFLICT`; a gap is `SEQUENCE_GAP`; processing stops at the first held/rejected entry |
| Retained refusals | `offline_journal_review`: every held, rejected or conflicting upload and every conflicting sign-in, one row per distinct signed content, never deleted |
| Sign-ins | `offline_staff_sign_in`: verified device-signed `OfflineStaffSignIn` attestations, kept once; commands cite them across uploads |
| Historical validation | Stored grant and snapshot, cited sign-in, D8 acknowledgement, `occurredAt` as trusted time (not ahead of the server, not before the previous entry), usage recomputed from accepted sales on the snapshot; shared `offlineSalePolicyError` / `offlineShiftTransition` |
| Sales (D1) | Sale + payments at the snapshot's prices and tax, staff, shift and counter attribution, `offline_command_id`; either the whole stock effect through `StockService.issue`, or `stock_posting = pending_reconciliation` with an `offline_stock_discrepancy` case (line per batch) and a `batch_sale_block` per batch — one transaction with the receipt and audit |
| Blocks | Central checkout refuses a blocked batch (`BATCH_STOCK_REVIEW`; FEFO skips it); snapshots mark it `stockReviewRequired` (the review-block set P3 left empty); a pending sale can't be voided or refunded (`STOCK_POSTING_PENDING`) |
| Shifts (D7b) | `shift_open` / `shift_close` replay into `till_shift` (from #125) once, in journal order: counter-generated work session ID, opening count, server expected cash beside the counter's, variance, assisted-close manager |
| Support records | Uploaded in the same request through the existing `OfflineSupportRecords.record`, acknowledged per record |

### Decisions taken in this slice

- **A sale is posted whole or not at all.** If any batch is short, every batch of the sale waits
  on one case and is blocked: the unposted units of the batches that were not short are also
  physically gone, so leaving them sellable centrally would create the next shortfall. Each case
  line says why it waits (`shortfall`, `batch_under_review`, `sale_pending`).
- **A blocked batch takes no further offline posting.** A later offline sale from a batch an
  open case holds is pending too (`batch_under_review`), even if units remain: that batch's count
  is under review and the case has unposted claims on it.
- **Shift close keeps both figures.** The variance on record is the count less the server's
  expected cash from the replayed sales (as online). The counter's own figure is stored beside
  it and is not used to refuse a count (the P0 fixture's equality check is satisfied with the
  counter's figure, so a disagreement is visible rather than a rejected close).
- **Offline sales name the offline sign-in in `sale.work_session_id`** (online it names the
  server staff session); the shift is `shift_id`, as online. This keeps the existing
  `sale_counter_attribution_check` without rewriting a constraint on `sale`.
- **Usage is the accepted journal's**, across outages that share the snapshot. It does not
  include the counter's own online sales after the snapshot, which the device subtracts locally:
  the server's check is therefore no stricter than the device's, and central stock still decides
  posting under D1.
- **Expiry is judged at the sale's time, not at sync.** The snapshot's `sellBefore` is checked
  against `occurredAt` by the policy fixture; a batch that expired (or was flagged for expiry
  review) after the sale still posts, because the units left the shelf while sellable. Quarantine
  and reservations made since are respected: they reduce what is available to post.
- **Malformed or unsigned input refuses the whole request** (400 / `INVALID_SIGNATURE`) and is
  not stored; a well-formed, correctly signed entry that fails policy is acknowledged and kept.
- **Held vs rejected.** `held`: repairable by sending something else (`SEQUENCE_GAP`, missing
  sign-in `SESSION_INVALID`, missing `BUSINESS_HOURS_ACK_REQUIRED`) or awaiting review
  (`TERMINAL_REVOKED`). `rejected`: that content will never be accepted (`REPLAY_CONFLICT`,
  policy codes).
- **Shared contracts unchanged.** `OfflineStockDiscrepancy` maps to one case line (case ID +
  batch); nothing needed adding.

### Schema (migrations `20261106000000_offline_journal_intake`, `20261106000100_offline_journal_intake_validate`)

New tenant tables, each with a staged `pc_tenant_isolation` policy and retention triggers:
`offline_staff_sign_in`, `offline_journal_review`, `offline_stock_discrepancy`,
`offline_stock_discrepancy_line`, `batch_sale_block`. New columns: `sale.offline_command_id`,
`sale.stock_posting` (enum, default `posted`, constant default so no rewrite);
`till_shift.open_command_id`, `opened_sign_in_id`, `closed_sign_in_id`, and
`opened_staff_session_id` nullable. `sale_stock_posting_offline_check` and the widened
`till_shift_shape` are added `NOT VALID` and validated in the second migration.

### Tests

Unit: `offline-journal-wire.spec.ts`, `offline-sale-commit.spec.ts`. PostgreSQL:
`test/integration/offline-journal.int-spec.ts` — shift open/sales/close round trip and lost
response, assisted close and next shift, reordered upload with a gap, modified upload and broken
chain (`REPLAY_CONFLICT`, retained), concurrent identical retries, the contract's partition
(10 / 7 online / 5 offline → 2-unit case, batch blocked, other batch sells, retry returns the
case, later sale into the blocked batch pending), a sale with one short batch, recovery after
grant expiry, revoked counter recovery, unsigned/malformed uploads, snapshot pricing and a late
sign-in, support records and a wrong counter login.

## Slice 2 — manager review and resolution of discrepancy cases (built)

Revised D10: approve remotely online, execute physically at the enrolled counter.

| Area | What exists |
| --- | --- |
| Review | `GET /offline-stock-cases` and `/:id` (`inventory.resolve_stock_cases`, new, owner and manager by default): the sale with receipt and payments, the offline evidence (counter, sequence, sign-in, staff, sync time, uploader), and per batch the pending units (this case and other open cases), stock now, the ledger timeline since the snapshot (online sales, receipts, transfers, stocktakes, quarantine, adjustments) with a digest, stocktake counts, reservations and linkable write-offs |
| Web | Inventory → Stock cases (`/inventory/stock-cases`): evidence, plan form, approval evidence (requester / approver / executor), "Approved — waiting at the counter" handoff, "changed since approval" warning. Daily work lists open cases (`offline_stock_case.review`) and approved plans (`offline_stock_case.resolve`, counter work) |
| Plans | `offline_stock_resolution`: `post_now`, `count_and_correct` or `link_existing_settlement` (links to a posted stocktake counted after the sale, or to write-offs after the sale), one open plan per case, content immutable (trigger) |
| Approval | Existing exact approval (`management_approval`, `offline_stock_resolution.execute`): material = case, plan and the other open cases on each batch; self-approval policy; stale on any material change (`APPROVAL_STALE`) |
| Execution | Signed operation `POST /api/v1/offline-stock-cases/resolutions/:id/execute` through `TerminalCommandsController` / `SignedCommandService`, `inventory.manage`; the browser route always refuses `TERMINAL_REQUIRED`; never an offline journal command. One transaction: lock case → plan → batches, re-check approval, post / correct / link, one `offline_stock_settlement` per batch (+ `offline_stock_settlement_link` per linked movement), sale → `posted`, case → `resolved`, release this case's blocks, audit. Idempotent through the command receipt |
| Desktop | Counter work's Stock tab: "Offline sale stock" items with the approved plan, the "matches the approved version" header, a blind count box per batch for `count_and_correct`, and Settle stock |

### Decisions taken in this slice

- **A count corrects to count + every open case's pending units on the batch**, then posts this
  sale. The count is taken after the offline sales left the shelf, so it already reflects all of
  them; adding back the other cases' pending units keeps them owed, so when those cases post
  later nothing is deducted twice. Central stock ends equal to the count once every case is
  settled. The correction is an ordinary `adjustment_in` / `adjustment_out` through StockService,
  dated at the count; the sale's posting is dated at the sale (as slice 1 posts sales).
- **post_now needs only this sale's units available** (StockService's own check); other open
  cases on the batch keep their claims and their blocks. The manager sees their pending units in
  the evidence before approving.
- **A count covers held units.** It counts every unit, so held units stay held only as far as
  the count leaves room beside this sale's units; the rest come off the quarantine bucket, and
  the sellable bucket takes the remainder of the correction (`correctionBuckets`). The sale
  always posts from sellable stock.
- **post_now never re-deducts a count.** If a posted stocktake counted a batch after the sale,
  post_now is refused `SETTLEMENT_ALREADY_COUNTED` at preparation and execution; link the
  stocktake or count instead.
- **Another open case on a batch is material.** It changes what a count must account for, so a
  case opened after approval makes the approval stale; approve again. A case that resolves after
  the plan was prepared stays in the material, so one case settling never stales another's
  approval. Daily work shows a stale approved plan as "Approve stock case plan again", not as
  ready at the counter.
- **A stock case's own count correction is never linkable** by another case (movement
  candidates exclude reference `offline_stock_resolution`): it settles that case alone.
- **A stocktake link** is valid when the stocktake posted and counted the batch after the sale:
  the count already took the sold units off, whatever its variance. Several cases may link the
  same count (each case once). **A movement link** spends a write-off's units at most once across
  all cases and must cover every sold unit; a partial link is refused.
- **Blind counts at the counter.** The counter's plan list never carries the system quantity.
- **Execution permission is `inventory.manage`** (owner, manager, inventory clerk): the count and
  correction are inventory work. Approval stays with `inventory.resolve_stock_cases`.
- **Executed plans are final.** A retry of the same signed command replays its receipt; a distinct
  later command is refused `APPROVAL_INVALID` (the approval resolves only for approved plans), as
  for stocktake posting.

### Schema (migrations `20261107000000_offline_stock_case_resolution`, `20261107000100_offline_stock_case_resolution_validate`)

New tenant tables, each with a staged `pc_tenant_isolation` policy: `offline_stock_resolution`
(immutable content; one open and one executed plan per case), `offline_stock_settlement` and
`offline_stock_settlement_link` (append-only). `management_approval_shape` gains the
`offline_stock_resolution` pair, added `NOT VALID` and validated in the second migration. The
`inventory.resolve_stock_cases` permission is granted to built-in owner and manager roles.

### Tests

Unit: `stock-cases/stock-case-plan.spec.ts` (kinds, links, material, counts, the correction,
movement allocation, timeline digest); the signed-operation parser and registry
(`terminal-command.executor.spec.ts`); counter routes; daily-work kinds. PostgreSQL:
`test/integration/offline-stock-cases.int-spec.ts` — the contract's 10/7/5 resolved by
count_and_correct with remote approval and refused remote/offline execution, requester / approver
/ executor, snapshot and refund after resolution; a second open case making the approval stale
and keeping the block until it is resolved; concurrent identical retries executing once; a
stocktake that already counted the sale linked without a second deduction (and post_now refused
`SETTLEMENT_ALREADY_COUNTED`, prepared before or after the count); one case resolving leaving
another's approval standing, its correction never linkable; a count over held units; a
write-off linked once and post_now after a receipt; executor
permission, wrong counts and the immutable plan. The slice 1 harness moved to
`test/integration/offline-counter.kit.ts`, shared by both suites. Web:
`inventory/stock-cases/case-detail.spec.tsx`. Desktop: `CounterWork.spec.tsx` (Stock tab) and
`main/terminal/counter-work.spec.ts`.

## Later slices (not built)

- Snapshot rebase and grant renewal over a non-empty journal (issuance still refuses with
  `RECONCILIATION_REQUIRED`).
- Support-record gating of dependent commands (held support records do not yet hold a sale).
- Replacement and missing-journal review (D11 `journalRecoveryEvidence`), backup and restore.
- The desktop producer (P4 #50); this slice is exercised with signed fixtures only.
- A concrete retention policy for journal evidence (nothing is deleted today).

## Counter sync status for managers (built)

Until now only the counter knew how far its journal had reached the server (its readiness
Synchronisation row). Managers now see it per counter, from the server's own records.

| Area | What exists |
| --- | --- |
| Read | `GET /terminals/offline-journal/sync-status` (`tenant.management`, live at the branch): per enrollment the accepted head and when it was accepted, the last upload, entries waiting past the head (held) and needing review (rejected or conflicting), the first stuck entry, and open stock cases. One repeatable-read statement over `terminal_command_receipt`, `offline_journal_review`, `offline_staff_sign_in` and `offline_stock_discrepancy`, every table scoped by tenant and branch (`journal/counter-journal-status.ts`) |
| Counters page | Settings → Counters has an "Offline sales" column: "All on the server, last sync 14:02", "3 waiting / 1 needs review" with where the journal stopped, a link to Inventory → Stock cases for open cases, and an earlier revoked key or retired computer of the same counter while its entries still wait. A failed status read leaves the counters list working ("Couldn't check") |
| Daily work | `offline_journal.review`, "Offline sales stuck at a counter": one item per enrollment stuck past its head on a rejected or conflicting entry, for `tenant.management`, linking to Counters |

### Decisions

- **The server's records, not the counter's word.** Nothing here is reported by the counter; it
  is what the server accepted and retained. So "all on the server" means every entry the counter
  has sent was accepted: a counter that is offline now may hold sales it hasn't sent yet, and the
  page says so.
- **Last sync is the last upload that brought something.** An empty confirmation upload (slice 3
  sends one every 5 minutes) writes nothing, so it can't be seen; the status stays read-only
  rather than writing on every upload.
- **Counted per sequence, past the head only.** A sequence with any rejected or conflicting copy
  needs review; otherwise a held one waits (the counter repairs it by sending what it lacks, or it
  waits for D11 review on a revoked key). Refusals at or below the head are kept as evidence but
  are not status: a conflict on an accepted entry leaves the accepted one standing.
- **Existing permission.** `tenant.management` is what the Counters page already requires; no
  new key.
- This covers "sync lag visible centrally" from the later slices list.

### Tests

Unit: `journal/counter-journal-status.spec.ts` (row mapping, which enrollments are listed,
tenant/branch scoping of every table, the service's permission and snapshot),
`terminal-routes.spec.ts`, `daily-work-kinds.spec.ts`. PostgreSQL:
`test/integration/counter-journal-status.int-spec.ts` — head and last upload, a held entry
waiting until it is accepted, a rejected entry and a fork past the head stopping the journal (and
the Daily work item, only with `tenant.management`), a conflict at the head not counted, open
stock cases, a revoked counter listed only while entries wait, other tenants and branches, and
refusal without the permission. Web: `settings/counters/page.spec.tsx`, `offline-sync.spec.tsx`.
