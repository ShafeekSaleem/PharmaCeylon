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

## Later slices (not built)

- Snapshot rebase and grant renewal over a non-empty journal (issuance still refuses with
  `RECONCILIATION_REQUIRED`).
- Manager discrepancy review and resolution: exact-version authorization, local execution of the
  stock correction, block release.
- Support-record gating of dependent commands (held support records do not yet hold a sale).
- Replacement and missing-journal review (D11 `journalRecoveryEvidence`), backup and restore.
- The desktop producer (P4 #50); this slice is exercised with signed fixtures only.
- A concrete retention policy for journal evidence (nothing is deleted today).
