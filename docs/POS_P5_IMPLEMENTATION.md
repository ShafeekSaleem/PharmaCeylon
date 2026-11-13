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
  line says why it waits (`shortfall`, `counted_after_sale`, `batch_under_review`,
  `sale_pending`).
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
- **A retained refusal only escalates** (migration `20261109000000_offline_journal_review_escalation`).
  The same content can be refused more than once, e.g. held for its sign-in and then, once
  judged, rejected. Its row's `outcome` is the worst refusal so far (held < rejected < conflict),
  with that refusal's `error_code`. A milder refusal later, such as `TERMINAL_REVOKED` after
  revocation, only counts as an attempt. The table's trigger enforces this, and an escalation is
  audited (`terminal.offline_journal_escalated`). Issuance, sync status and review all read
  `outcome`, so a held-then-rejected entry has to count as stuck.
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
sign-in, support records and a wrong counter login. Also a held entry that is rejected once
judged, which escalates, blocks issuance and is never softened by a later `TERMINAL_REVOKED`.

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
  or another case counted it after the sale and before this case opened, post_now is refused
  `SETTLEMENT_ALREADY_COUNTED` at preparation and execution; link the stocktake or count instead.
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

## Slice 3 — desktop journal upload, reconnect drain and the rebase (built)

Approved D12: after an outage the nominated counter pauses new sales, uploads its journal,
resolves what it sent without an answer, installs a fresh pair rebased over the accepted journal,
and only then sells again.

| Area | What exists |
| --- | --- |
| Rebase (server) | Issuance and renewal no longer refuse an accepted journal: the snapshot's `includedThroughSequence` / `includedThroughHash` are the accepted head (`acceptedJournalHead`), read in the issuance's repeatable-read view together with the stock it signs. Posted offline sales are already out of that stock; pending ones hold their batches as `stockReviewRequired` through `batch_sale_block`. `RECONCILIATION_REQUIRED` now means the journal is stuck past its head on an entry that was rejected or conflicts (`journalAwaitingReview`), refused at the challenge as before |
| Upload (desktop) | `main/terminal/offline-journal-sync.ts`: every 15 s while someone is signed in, entries not yet accepted go to `POST /terminals/offline-journal/sync` in sequence order, 50 per request and up to 20 requests per cycle, with every staff sign-in they cite. With nothing waiting, an empty upload every 5 minutes has the server confirm the whole journal |
| Trust | `verifySyncResponse`: the offline authority key, purpose `sync_response`, this exact identity, a canonical watermark, and one acknowledgement per entry sent, in order, with its exact hash, sequence and kind, nothing after a refusal and nothing committed past the watermark. A reply that fails any check applies nothing (`RESPONSE_INVALID`) |
| Local state (migration 16) | `offline_journal_command` gains `acknowledgement_json`, `acknowledged_at`, `last_error_code`; `offline_journal_sync` keeps the server-confirmed watermark (sequence and hash set together, only moving forward), the last confirmation, the current issue and the last drained outage |
| Outcomes | `committed` / `duplicate` → `synced` with the acknowledgement kept; `held` stays `pending` and is resent after 60 s; `rejected` → `failed`, and nothing after it is sent (slice 4: resent alone once a minute until a manager settles it). A lost reply is recovered by resending the same entries: the server answers `duplicate` |
| Drain (D12) | `main/terminal/reconnect-drain.ts`: `mayResumeOnlineCheckout` over trusted local facts (journal accepted through the head, no `submitted` / `uncertain` checkout drafts or signed actions, the fresh pair's snapshot and review blocks). Once the journal is accepted the coordinator asks for a fresh pair at once (`renewNow`); installing it ends the outage in the same transaction. If the server refuses the counter offline authority (not nominated, `GRANT_INVALID`), the drain ends without a pair, because online checkout checks stock centrally |
| Pause | `CheckoutService.submit` refuses `SYNC_PAUSED` while an outage is draining or entries wait; confirming an unconfirmed sale (`retry`) still works. Sell shows "Synchronising offline sales" over the kept cart (`SyncBlock`), and readiness has a real Synchronisation row |
| Installer | The pair is installed only if its watermark is exactly the local head (`journalCoverage`): `behind` → `local_usage` (upload first), `mismatch` → `journal_mismatch` (never installed), and during a drain with something unconfirmed → `drain_incomplete`. Installing resets the replaced snapshot's usage, which the new snapshot already includes |
| Restore detection | A server watermark that names entries this computer doesn't have records `JOURNAL_MISMATCH` and is never adopted. P4's `ensureOfflineOutageSession` then refuses `RECONCILIATION_REQUIRED`, so no outage starts on a restored or damaged journal |
| Title and status bars | `app_meta` keys `counter_sync_in_progress` (`"1"` while a cycle runs, reset at start-up) and `counter_last_successful_sync_at` (the last full confirmation), which PR 138 reads |

### Decisions taken in this slice

- **Accepted is the server's signed word, nothing else.** An entry is `synced` only from a
  verified reply that names its hash and sequence; the watermark is recorded only when it names
  this computer's own chain. The local journal is never trimmed: accepted entries stay as
  evidence, and the next outage continues the chain.
- **The rebase is the install.** There is no separate rebase step on the counter: a fresh pair
  whose watermark equals the local head *is* the rebased authority. It resets local usage (the
  snapshot already took the posted sales off and blocks the pending ones), and during a drain it
  also ends the outage, in one SQLite transaction, so checkout resumes on fresh stock or not at
  all.
- **No wasted grant versions.** Renewal is skipped while entries wait for the server (a pair
  issued then could not include them), and a pair that is `behind` is not installed. Waiting is
  not a failure: nothing is asked, nothing backs off, and the next minute's check after the
  upload is accepted asks. The coordinator asks for one immediate renewal per outage and journal
  head, then the refresh's own back-off applies — except that it asks afresh each time the drain
  becomes ready again, so a sale confirmed after a `drain_incomplete` refusal doesn't wait out
  that refusal's back-off.
- **The drain waits only for what this enrollment can confirm.** Unconfirmed online sales and
  signed actions count when this enrollment sent them (a signed action by the enrollment its
  envelope names; a draft from before drafts recorded one still counts, since it can be resent).
  An earlier enrollment's leftovers can't be resent from here, so they never hold the drain. The
  pause carries the counts: Sell's block names them and holds the unconfirmed sales, which are
  confirmable only on Sell, and readiness says what the drain is waiting for.
- **A `drain_incomplete` install still records the pair's watermark.** It is the server's signed
  acceptance of the journal whatever the install makes of the pair, and it only moves forward;
  after a lost upload reply it is the only evidence the journal arrived.
- **Finishing without a pair.** A counter that is no longer the offline counter, or whose branch
  no longer allows offline selling, will never get a rebased pair. Its drain ends once the
  journal is accepted and nothing sent is uncertain (the same `mayResumeOnlineCheckout` rule the
  installer applies, less the fresh snapshot). Only an answer given since the drain asked counts:
  a refusal from before the outage is stale. Its old pair stays installed, unrenewed, and is soon
  too old to start another outage on.
- **A journal the server doesn't recognise is a recovery issue, not a sync error.** It fails the
  readiness row and refuses new outages until the D11 journal recovery (below) completes.
- **Held entries back off, rejected ones stop.** Held ones are resent after 60 s, because the
  server may be waiting for something else (a sign-in, a manager's after-hours approval).
  Rejected ones wait for review. The server refuses renewal on them too, so the counter does not
  keep minting versions it cannot install.
- **Sync runs only while someone is signed in and the counter is unlocked**, like the authority
  refresh: the request needs a counter session.

### Tests

API (PostgreSQL): `offline-authority.int-spec.ts` covers a renewal rebased over the accepted
journal, the first pair issued at the head, a refusal while the journal is stuck past its head
(held entries and conflicts at or below the head don't refuse) and a fork.
`offline-journal.int-spec.ts` covers the 10/7/5 partition rebased: posted sales come off and
the pending batch is `stockReviewRequired`.

Desktop:

- `offline-journal-sync.spec.ts`, against a real encrypted store, the real P4 writer and a fake
  signing server: upload order and sign-ins, acknowledgements and the `app_meta` keys, a lost
  reply recovered as duplicates, held / rejected handling and back-off, batching, the empty
  confirmation, replies with a bad signature or wrong content, a restored-backup mismatch (kept
  through a dropped connection or a bad reply, and cleared only by a verified reply), the
  drain's install ending the outage, `drain_incomplete`, a `behind` pair, and the coordinator
  (immediate renewal, finishing without a pair, ignoring a refusal from before it asked, never
  finishing with entries waiting, asking again once the last unconfirmed sale is confirmed), the
  watermark a `drain_incomplete` install records, the drain waiting only for this enrollment's
  unconfirmed sales and actions, and the last-sync key following the enrollment signed in.
- `offline-journal-writer.spec.ts` (desktop), `offline-journal-wire.spec.ts` (API) and the shared
  package's tests all check `packages/shared/test/journal-command-hash.json`: the desktop's
  `journalCommandHash` and the API's `journalHash` give the same hash for the same entry.
- `checkout-service.spec.ts` covers `SYNC_PAUSED` with retry still working.
- `shell.spec.ts` covers the Synchronisation readiness row.
- `Shell.spec.tsx` covers `SyncBlock`; `Sell.pending.spec.tsx` covers confirming an
  unconfirmed sale under it.
- `migrations.integration.spec.ts` covers the upgrade from 15 to 16.
- `offline-authority*.spec.ts` covers the installer's new results, and the refresh: waiting for
  the upload without a request or a back-off, due at once during an outage, and `renewNow`.

## D11 — journal recovery and replacing the offline counter (built)

Approved D11, P5's half (`journalRecoveryEvidence`), with the policy decided on 2026-11-10. Two
supervised online procedures, both approved by a person in the back office:

1. **A restored counter** (`JOURNAL_MISMATCH`: its journal is not the server's — an old backup, a
   damaged store) recovers onto the server's chain. It never writes at a sequence the server
   accepted and never sells again on authority it held before.
2. **Replacing the offline counter** while its journal is missing or unsynced needs a
   missing-journal sign-off, possible only once the old counter's last issued grant has expired.

| Area | What exists |
| --- | --- |
| Chain (counter route) | `POST /terminals/offline-journal/recovery/chain`: accepted entries after a sequence (≤ 100), the sign-ins they cite, and the head. Every entry is the counter's own signed envelope, so it verifies each against its own key and the chain from a position it already holds: the server can withhold entries, never invent them |
| Report (counter route) | `POST …/recovery/report`: a device-signed `offline_journal_recovery_report` (server head, common prefix, local head) with the unmatched local entries in pages of ≤ 25 (the 100 kB body limit), oldest first, each continuing from the last received; re-pages are idempotent, and nothing past the local head or already accepted is taken. A new report supersedes any open one; resending the same `reportId` is the same recovery. Refused `JOURNAL_RECOVERY_STALE` if the head moved, `_INVALID` if the common prefix is not the server's, `_NOT_NEEDED` if the counter has the whole server chain (it is only behind) |
| While open | Issuance and the challenge refuse `RECONCILIATION_REQUIRED` (`refuseUnsettledJournal` → `journal-recovery-gate.ts`) while an open restore names the current accepted head. One whose head the journal has moved past no longer describes it and is superseded there, so a report from a copy that was wiped cannot hold the counter for good. Nothing is posted: unmatched entries are evidence (`offline_journal_recovery_entry`), never sales or stock |
| Approval (web) | `GET /offline-journal-recoveries` (+ `/:id`) and `POST /:id/approve`, `tenant.management` plus revised D13 authority (owner, or a manager with a live delegation; else 403 `OFFLINE_ASSIGNMENT_NOT_DELEGATED`). The approver sees the unmatched entries (who, when, total, lines) and approves exactly them (`expectedServerHeadSequence`, `expectedUnmatched` = every record the report names) with a reason saying how their stock and cash were settled. Completeness is checked before the count, so while pages are still arriving the refusal is `_EVIDENCE_INCOMPLETE` (with `received` and `unmatched`) rather than "changed"; the review shows received of total and keeps Approve off until all have arrived |
| Close (web) | `POST /offline-journal-recoveries/:id/close`, same authority, with a reason (audited `terminal.journal_recovery_closed`): an open restore that will never complete (the restored computer was wiped, or is not coming back) becomes `closed`. Refused `JOURNAL_RECOVERY_NOT_OPEN` otherwise; a later approve or complete is `_NOT_APPROVED`, and the counter, if it comes back, is told it is over and reports afresh |
| After a restore | Once an approved restore finishes (`recovered`, or `closed` after approval, since the copy may have applied it), issuance and the challenge refuse `RESTORED_COUNTER_WAIT` (with `availableAt`) until every grant issued before that moment has expired: the computer the copy was made from may still hold one (D11, wait out the last grant). Online selling is never held. The review and the recovery's detail show `offlineResumesAt`; a restore closed before approval restored nothing and waits for nothing |
| Apply (desktop) | `main/terminal/journal-recovery.ts`, run by the sync coordinator after each upload while `JOURNAL_MISMATCH` stands. In one SQLite transaction: unmatched entries move to `offline_journal_set_aside` (kept for good; delete and update abort), the server's entries after the common prefix are inserted as `synced`, the journal state and accepted watermark move to the server head, the installed pair and any pending renewal request are deleted, batch usage is reset and the issue cleared. Then a device-signed `offline_journal_recovery_completion` goes to `POST …/recovery/:id/complete`; the coordinator asks for a fresh pair at once |
| Stale | If the server's journal moves after the report (the original computer is still alive), approve, status and complete supersede the recovery and commit that before refusing `JOURNAL_RECOVERY_STALE`; the counter reports again by itself. If the counter recorded more offline sales since reporting, it reports again too. The status call carries the counter's `localHead`: an open recovery reported from another head is moot and is superseded, and the counter keeps asking about its open recovery after its mismatch clears, so a moot one does not linger |
| Sign-off (web) | `POST /offline-journal-recoveries/missing-journal`: owner or delegated manager, bound to the nomination version and accepted head shown (`expectedNominationVersion`, `expectedServerHeadSequence`), refused `JOURNAL_SIGN_OFF_TOO_EARLY` (with `availableAt`) before the last issued grant's `expiresAt`, and `JOURNAL_RECOVERY_OPEN` while a restore of that counter is open (decide or close it first). A later sign-off supersedes the earlier one |
| Clearance | `OfflineActivationClearance.journalRecoveryEvidence` → `missingJournalEvidence`: a live sign-off for this nomination version whose head is still the accepted head, that was made at or after the last grant's expiry (so a renewal issued after it makes it stale), and whose evidence mark (`refusals_seen`, `restores_seen`: the retained refusals and restore reports for the enrollment, rows that are only ever added) is still the evidence's. A revoked counter's accepted head cannot move, but what it uploads after the sign-off is still kept as refusals, so the sign-off goes stale on it. Activation takes the journal lock before it reads the head. `D11_CLEARANCE_REQUIRED` carries `journalSignOffAvailableAt`; the activation audit records `journalSignOffId` |
| Schema | Migrations `20261110000000_offline_journal_recovery` and `20261110120000_offline_journal_recovery_close` (the `closed` status, the closure columns, all or none and only on a restore, and the sign-off's evidence mark): `offline_journal_recovery` (shape checks per kind, approval whole or absent, one open restore per enrollment, a trigger allowing only forward transitions with content fixed) and `offline_journal_recovery_entry` (immutable). Desktop migration 17: `offline_journal_recovery` (the counter's current recovery, its stored signed report and completion) and `offline_journal_set_aside` |
| Back office | Settings → Offline policy → Offline counter journal (`journal-recovery-card.tsx`): the offline counter's accepted records, cutoff, retained refusals and sign-off state (and when a sign-off becomes possible), the sign-off form, restored counters waiting for approval with a review dialog (received of total, when offline selling resumes) and a close dialog, and earlier recoveries |
| Counter copy | While a recovery runs, the Synchronisation issue says where it stands (sending for review, waiting for approval in Settings → Offline policy, finishing) |

### Decisions taken in this slice (2026-11-10)

- **Who approves: the owner, or a manager the owner delegated for the branch** (revised D13,
  `OfflineAssignmentService.authorityOf`) — the same authority that assigns the offline counter.
- **Always a person.** Even when the evidence shows nothing is missing (a restored backup that
  is only a prefix of the server's chain, a counter that never had a grant), a recovery or a
  sign-off is approved by someone, with a reason. A never-issued counter's sign-off is available
  at once.
- **Wait out the last grant.** The missing-journal sign-off is possible only once the old
  counter's last issued grant has expired, even if it was revoked or retired: a disconnected
  device can sell on a grant it already holds whatever the server says.
- **Unmatched entries are evidence, never sales.** They stay on the counter
  (`offline_journal_set_aside`) and on the server (`offline_journal_recovery_entry`); the
  approver records in the reason how their stock and cash were settled (a stock adjustment, a
  cash count).
- **The server's chain wins.** The restored counter adopts the accepted entries rather than
  re-uploading its own, and continues at the server head + 1. Its restored grant is deleted
  before it confirms, and issuance stays refused until it has confirmed.
- **Wait out the last grant after a restore too.** A restored copy and the computer it was
  copied from can both hold the grant issued before the restore, so the restored counter is
  issued offline authority again only once that grant has expired. Online selling carries on.
- **An abandoned recovery is closed by a person.** A restore that will never complete is
  superseded when the journal moves past it; one that still names the current head is closed by
  the owner or a delegated manager, with a reason, never by a timer.
- **Stale is final.** A recovery or sign-off is bound to the server head (and, for a sign-off,
  the nomination version and the grants) it was made over; anything that moves them supersedes
  it and asks again, rather than approving something nobody looked at.

### Tests

API: `journal-recovery.spec.ts` (wire parsers, chain links, sign-off timing and staleness,
including the evidence mark).
PostgreSQL: `offline-journal-recovery.int-spec.ts` covers the prefix restore end to end
(chain, report, refused issuance while open, D13 authority, completion and its replay, the
rebased pair, audit), the forked restore (paged evidence, contiguity, incomplete and stale
approvals, no sale or stock posted, immutable rows), report refusals and supersede on a moving
journal (including after approval), the revoked counter's sign-off waiting for its grant then
the replacement activating with `journalSignOffId`, and a sign-off going stale on new journal or
a renewal. Also: the restore wait after completion (refused until the pre-restore grant's
expiry, then issued), a stale open restore superseded at issuance and a current one closed by the
owner (not an undelegated manager), a recovery moot by the counter's local head, an approved
restore closed before completing still waiting, a revoked counter's later upload making its
sign-off stale, and sign-offs refused for another nomination, a branch without an offline counter
or around an open restore. `offline-activation.int-spec.ts` now clears a never-issued counter
with a real sign-off.

Desktop: `journal-recovery.spec.ts`, against a real encrypted store and a fake recovery server:
a prefix restore (waiting, approval, adopting the server entries, the grant removed, the drain
still waiting for a fresh pair), a forked restore with paged evidence and set-aside rows that
cannot be changed, a lost report reply and a lost completion resent unchanged, a moving server
journal reported again, withheld and forged chains refused, a journal that is only behind left to
the upload, the coordinator renewing after completion, a completion refused after applying
(the server moved on, or the recovery was closed), a closed recovery reported afresh, an open
recovery still asked about after the mismatch clears and forgotten once moot, and evidence kept
once per record hash. `migrations.integration.spec.ts`
covers the upgrade from 16 to 17.

Web: `journal-recovery-card.spec.tsx` (sign-off waiting for the grant, the exact sign-off body,
a stale sign-off, reviewing and approving exactly the unmatched records, partial evidence
keeping Approve off, closing under StrictMode, a refusal kept in the dialog). Shared: `offline-journal-recovery.test.cjs`.

## Slice 4 — manager settlement of refused journal entries (built)

A command the server rejected used to stop its counter for good: the desktop marked it `failed`
and sent nothing after it, the server accepts only head + 1, and issuance refused
`RECONCILIATION_REQUIRED`, so the drain never finished. A manager now settles it, remotely, and
the counter carries on within a minute.

| Area | What exists |
| --- | --- |
| Routes | `apps/api/src/journal-reviews/`: `GET /offline-journal-reviews`, `GET /:id`, `POST /:id/settlements`, `POST /settlements/:id/approve`, `POST /settlements/:id/cancel`, all `sales.review_offline_entries` and `management` in the mutation inventory. Contract: [API_CONTRACT.md](API_CONTRACT.md#refused-offline-journal-entries-p5-51-slice-4) |
| Decisions | `recorded` (as it happened, only if its figures are exactly the snapshot's and the till and shift allow it) or `not_honoured` (no sale or stock; a card sale's payments kept as collected, not sold), a reason either way. A shift record the till can take is always recorded. Rules in `journal-reviews/journal-entry-settlement.ts` |
| Exact approval | `management_approval`, document `offline_journal_settlement`, action `offline_journal_settlement.execute`; material in `security/offline-journal-settlement-approval-material.ts` (the entry, the decision and reason, the accepted head it follows) |
| The chain | The settlement writes the server's receipt at the entry's own sequence and digest (`terminals/journal/journal-chain.ts` holds the journal lock, the head, and the till locks intake takes, in intake's order, so both writers judge the till alike). Later entries chain onto it; the clock floor skips settled receipts |
| Intake | A rejected entry's content is never judged again: a resend returns the stored refusal until it is settled, then `reviewed` from the receipt |
| Shared contract | `ReviewedEntryOutcome`; `SyncAcknowledgement` and `CommittedCommandReceipt` gain `status: "reviewed"` |
| Desktop | `offline-journal-sync.ts` sends a `failed` entry alone (the existing 60 s issue back-off paces it), verifies `reviewed` (kind, `committedAt`, the watermark, the review fields, and a recorded sale pending on a case), marks it synced and continues in the same cycle |
| Web | Inventory → Refused offline records (`/inventory/offline-records`): the list, the entry decoded, why it was refused, whether it can be recorded and what not honouring it leaves behind, the decision form (prepared with an `Idempotency-Key`), approval evidence, card money collected, not sold, and a link to a recorded sale's stock case. Stock cases show the `entry_reviewed` reason |

### Decisions taken in this slice (asked 2026-11-10)

- **Both decisions, with a reason.** Record it as it happened, only if its amounts add up, or
  don't honour it. Not honouring writes no sale or stock; the cash the counter took shows as
  that shift's variance.
- **A not-honoured card sale keeps its card money as collected, not sold** (asked 2026-11-10,
  review follow-up). The customer was charged, so each card payment is written as an
  `offline_collected_payment` (provider reference, approval code, shift) for a refund or a
  re-sale at the counter, rather than vanishing. Showing it in the shift summary is a follow-up.
- **A recorded sale always waits on a case, settled on the web.** It opens an
  `offline_stock_discrepancy` case and blocks its batches until the case is resolved at the
  counter (slice 2); no stock moves on a remote approval. Approval and settlement happen on the
  web, and the counter resumes within a minute.
- **A new permission**, `sales.review_offline_entries`, owner and manager by default (migration
  `20261110100000_offline_journal_settlement`), with exact approval and the tenant's
  self-approval rules.
- **Shift entries are recorded when the till allows it**: an open if no other shift is open on
  the till and its ID is unused, a close if that shift is still open. **A shift record the till
  can take must be recorded** (review follow-up): not honouring it would leave every later
  record in that shift unrecordable. It is not honoured only when it can't be recorded, and the
  page says what follows (later sales can then only be not honoured; a shift left open must be
  closed on the server).
- **A sale is recorded only as intake would have taken it** (review follow-up): onto the
  seller's own shift opened on this counter, under a sign-in that is this counter's, for the
  entry's own person and shift (an assisted close: the manager who closed it, on the same
  till).
- **A rejection is final for that content until settled**, so the answer the counter gets never
  drifts with the clock or the till. Recorded entries are dated at the counter's time but never
  after the server first saw them (a clock ahead of the server is one reason to refuse).
- **Out of scope here:** held entries (the counter repairs them), conflicts with the accepted
  chain, forked journals (two different entries refused at the same sequence, as after a
  restored backup) and revoked or retired counters (D11 journal recovery).
- **No new daily-work kind.** Approval is classified `management`, so the daily-work kind
  rule for physical approvals does not apply. The sync-status work lists rejected entries past
  the head; a settled entry has a receipt, so it drops out on its own.

### Schema (migrations `20261110100000_offline_journal_settlement`, `20261110100100_offline_journal_settlement_validate`)

- `offline_journal_settlement`: the review it settles, the entry's enrollment, command ID,
  sequence and digest, the decision and reason, `prepared` → `settled` | `cancelled`, the
  approval and result. A shape check ties each status to its fields; partial unique indexes allow
  one waiting and one settled per review and one settled per enrollment and sequence; a trigger
  keeps everything but the progress immutable; tenant isolation policy. The approver, canceller
  and execution approval are foreign keys.
- `offline_collected_payment`: a not-honoured sale's card payments (method, amount as
  `BIGINT`, provider reference, approval code, shift, seller, when collected), one per payment
  index per settlement, tied to the settlement and the shift; retained by trigger, tenant
  isolation policy.
- `offline_stock_discrepancy_line.reason` gains `entry_reviewed`;
  `management_approval_shape` gains the new document and action.
- `sales.review_offline_entries` is inserted and granted to the built-in owner and manager roles.

### Tests

- API unit: `journal-entry-settlement.spec.ts` (money checks, dating including a clock that
  gives no date, decision and reason parsing, explanations, the sign-in match including an
  assisted close, when a shift record must be recorded, what not honouring leaves behind);
  `offline-sale-commit.spec.ts` (a reviewed entry never posts).
- API (PostgreSQL), `offline-journal-reviews.int-spec.ts`:
  - A sale refused after the grant expired: issuance refused and resends answered with the
    refusal; review and detail; the cashier refused; reason required; exact approval with
    self-approval off for managers, a stale digest and an idempotent retry. Then a pending sale
    with an `entry_reviewed` case, the receipt at its sequence and the audit; the counter's
    resend answered `reviewed` in a verified signed response with the next entry committed;
    issuance rebased past it.
  - Not honoured: no sale, stock or case, and the cash shows as variance.
  - Figures that differ and a second shift open on a till: recording refused, not honouring
    allowed. A revoked counter: nothing to settle.
  - A shift open on a clock ahead of the server, dated when it arrived; the next, earlier entry
    is accepted.
  - Concurrent approvals settle once; a cancelled decision can't be approved.
  - Review follow-ups: a held-then-rejected entry settles; a not-honoured card sale keeps its
    payment as collected, not sold (retained); a close after the grant expired must be recorded;
    a sale onto someone else's shift, or under a forged sign-in, can't be recorded; a forked
    journal is `forked`; concurrent prepares with one `Idempotency-Key` settle once and
    replay; more than 200 overtaken entries don't hide an open one, and a clock that gives no
    date lists as `null` and is dated when it arrived.
- Desktop: `offline-journal-sync.spec.ts` — the probe once a minute, carrying on once settled,
  and the `reviewed` acknowledgement checks.
- Web: `record-detail.spec.tsx` (also the key per decision and reason, a recordable shift that
  can't be not honoured,   and collected payments).

## Backing up and restoring the counter's store (built)

Decisions of 2026-11-10. The counter's encrypted store holds everything P5 depends on: the
enrollment and its device key, the journal and its watermark, the installed pair, PIN verifiers,
the local side of stock cases, cash evidence and receipts. A failed disk or a damaged store used
to mean a new enrollment. Now the counter keeps its own backups and can restore one, and the
server makes sure a restore never revives superseded authority, resets the journal or hides what
was lost.

| Area | What exists |
| --- | --- |
| Backups (desktop) | `main/backup/store-backup.ts`: `VACUUM INTO` a copy, open it, delete every `staff_credential` row with `secure_delete` on and `VACUUM` so no PIN verifier survives in any page, `PRAGMA rekey` to a fresh random key, `quick_check`, then write that key wrapped by DPAPI (`SecretProtector`: this Windows user on this computer) and a manifest (`backup.json`: id, time, reason, app and schema version, enrollment, counter and branch, journal head and accepted watermark, outage, SHA-256). Written to `.partial-<id>` and renamed whole, under the app's `backups` folder and nowhere else |
| Schedule | Checked every 5 minutes once the store holds a counter: at start, whenever the journal head or watermark moved, and hourly if anything else changed; also before a schema upgrade. Keeps the newest 12 and the last of each of the past 7 days. A failed backup is reported, never fatal |
| Restore (desktop) | `main/backup/store-restore.ts`, offered at start-up only when the store cannot be opened or holds no counter (`liveStoreState`: never over a working store, nor over one a newer app wrote). Verifies the SHA-256, the key and `quick_check`; copies the backup to staging under a new store key and migrates it; then, in one transaction (`applyRestoreGuards`), deletes every PIN verifier, closes open staff sessions, deletes the installed pair and pending renewal requests, resets batch usage and records a device-signed restore report in `store_restore`. The broken store is moved to `set-aside/<time>-<restore>`, never deleted. A `restore.json` intent, written whole (a temporary file, flushed, then renamed; the staged key likewise), makes an interrupted swap finish (or a half-staged one drop) at the next start. A move refused while antivirus holds the file is retried; a swap that still cannot finish, or a damaged intent, ends start-up with an error box and opens nothing (opening would create a new store under the restored key). Only a store that cannot be decrypted, is corrupt or has an unreadable key counts as broken: a busy or locked file is shown as an error, never restored over. Nothing at start-up can leave the app with no window: `openStoreAtStartup` returns every failure, `start()` has a catch, and the backup schedule reports instead of throwing |
| Journal | Untouched: the restored chain continues from its own head. If the server has moved past it (the backup is older than the last upload) or the chains diverged, `JOURNAL_MISMATCH` and D11 recovery take over as for any restored counter |
| Report (counter route) | `POST /terminals/offline-journal/restore/report` and `…/status` (`store-restore-sync.ts`, run by the sync coordinator): the report is resent until answered; the answer gives the server's `latestGrantVersion` |
| While unacknowledged | Desktop: no offline outage, no journal entry, no install (`restore_unacknowledged`), no renewal request; the Synchronisation row shows `STORE_RESTORED`. Server: issuance, the challenge and replays refused `RECONCILIATION_REQUIRED` (`counterRestoreOpen`). Online selling continues, except that a backup taken mid-outage restores that outage, whose drain pauses online checkout until a fresh pair installs |
| Acknowledgement (web) | Settings → Offline policy → Restored counters (`counter-restore-card.tsx`): what may be missing (since the backup; the server's last contact is shown beside it, because a sign-in during an unfinished drain proves no upload), a warning instead when the counter's clock disagreed (`clockSkew`: a backup dated after its restore, or times ahead of the server), the outage, the restored journal against the server's, and the acknowledgement with a reason. `POST /offline-counter-restores/:id/acknowledge`, owner or delegated manager |
| After | The counter learns of the acknowledgement on its next status poll and asks for a pair at once. It installs only a version above the server's `latestGrantVersion`; that install clears the restore and, if an outage was restored, ends it |
| Late counts | A late offline sale's batch that a posted stocktake (or another case's count) counted after the sale waits on its case as `counted_after_sale` instead of posting: that count already took the units off. Restores make late uploads likelier, but this held before them too |
| Schema | API migrations `20261110200000_offline_counter_restore` (table, shape checks, the progress trigger, and the widened `offline_stock_discrepancy_line_shape`, NOT VALID) and `20261110200100_offline_counter_restore_validate`; `20261110200200_offline_counter_restore_clock` drops the shape's `backup_taken_at <= restored_at`. Desktop migration 18: `store_restore` (rows kept; what was reported cannot change) |

### Decisions taken in this slice (2026-11-10)

- **Backups stay on this computer**, each under its own key that only this Windows user here can
  unlock (DPAPI), with every PIN verifier removed. The device signing key is inside the encrypted
  copy and is never usable without that key; a backup copied elsewhere gives nothing.
- **Anyone at the computer may restore, but only onto a broken or empty store**, never over a
  working one.
- **The back office acknowledges before offline selling resumes.** The owner or a delegated
  manager (revised D13) says how receipts, cash and stock since the backup were checked. Online
  selling continues meanwhile, unless the backup was taken mid-outage.
- **A restore never revives authority.** The pair and renewal requests go at restore; nothing is
  issued or replayed while the restore waits; the counter refuses any pair at or below the
  server's latest version. Outside a restore a request still replays its own version (P3).
- **The journal is never reset.** The restored chain keeps its sequence; where it and the
  server's disagree, the server's wins through D11.
- **A wrong clock is recorded, not refused** (review of #156). Both times in the report are the
  counter's own clock. A restore whose backup is dated after it (a reset CMOS clock, or a fast
  clock corrected since) used to be refused for good, and with it offline selling; now the
  server records it and the card tells the acknowledging manager the counter's times can't be
  trusted. Refusing to restore until the clock is fixed was the alternative, but when the
  backup's own time was the wrong one there is no clock to fix.

### Tests

Desktop (real SQLCipher stores): `store-backup.spec.ts` (a backup under its own key with no PIN
verifier and no plain text, unreadable to another Windows user; partial and broken backups
skipped; retention; the schedule; a failed backup reported). `store-restore.spec.ts` (no restore
over a working store, from a tampered backup, with another user's key or from a newer app;
restoring an older store against a server that moved on: the journal kept, the pair, requests,
usage and PINs gone, sessions closed, the signed report verified, no outage and online checkout
paused by the restored outage, installs refused until acknowledged, the report, poll and
acknowledgement flow, v1–v3 refused as superseded and a rebased v4 left to D11; clearing after
acknowledgement with the chain continuing; start-up after a failure, an emptied data folder, a
working store the app cannot open, and interrupted restores: a damaged intent and a held file
both stop start-up without opening anything and the swap finishes at the next start, an
uncommitted intent drops, a file held for a moment is waited out, and a store that is only busy is
never restored over; a clock behind the backup still restores, each restore in its own set-aside
folder; an empty status answer resends the report). `store-backup.spec.ts` also: a store that
cannot be read is reported, never thrown. `offline-authority.spec.ts`: no
renewal request while a restore waits. `migrations.integration.spec.ts`: the upgrade from 17 to
18.

API: `counter-restore.spec.ts` (wire), `offline-sale-commit.spec.ts` (`counted_after_sale`).
PostgreSQL: `offline-counter-restore.int-spec.ts` covers a counter restored from an older backup
after two renewals (report and resend, other content and a foreign signature refused, issuance
and replays refused while it waits, D13 authority, one acknowledgement, the version floor, the
next pair above it and rebased, the record immutable, audit), a counter whose clock was set back
or runs fast recorded with its skew (in the view and the audit) and acknowledged as usual, and a
late sale over a later stocktake waiting as `counted_after_sale` with nothing deducted twice.

Web: `counter-restore-card.spec.tsx` (what may be missing, counted from the backup whatever
contact came after; the clock warning; the exact acknowledgement; a refusal kept in the dialog).
Shared: `offline-counter-restore.test.cjs` (`counterRestoreClockSkew`).

## Support records and card attempts on the desktop (built, P4 #50)

Until now the drain treated "support records accepted" and "payment attempts resolved" as true
because nothing on the counter wrote either. The desktop now writes, uploads and gates on them.
Nothing in the renderer calls the writers yet: the screens that record a note or a card payment
arrive with offline selling (the rest of P4).

| Piece | Where |
| --- | --- |
| Table | `offline_support_record` (migration 19): the device-signed envelope as signed, its SHA-256, upload bookkeeping. Never deleted; the signed content can't change |
| Writer | `OfflineSupportRecordWriter` (`offline-support-records.ts`): `recordSaleIncident`, `prepareCardAttempt`, `recordCardAttemptEvent` |
| Upload | `offline-journal-sync.ts` sends pending records in `supportRecords`, up to `SUPPORT_BATCH` (25) a request, with or without journal entries, and with the sign-ins they cite |
| Gate | `drainResumeEvidence`: `supportRecordsAccepted` and `paymentAttemptsResolved` now come from local state |

**What the writer checks before it signs** (so a record the server would refuse is never stored):
identity is read from the enrolled device; the cited sign-in is held here and is the recorder's; the
record sits inside the installed grant's window; free text and card-machine references hold no full
card number (`containsCardNumber`); an incident cites an offline sale this counter wrote.

**Card attempts.** Each state change is its own immutable event. The first, `prepared`, is stored
before the card machine is asked to charge, and fixes the draft, digest and amount; later events
inherit them. Allowed steps: prepared → uncertain / approved / declined, uncertain → approved /
declined, approved → linked to the sale. External card must be allowed by the signed grant. A new
attempt for a draft is refused while an earlier one for it is unsettled, so there is never an
automatic second charge. Linking needs a sale in this journal that holds the approved card payment
(same provider reference and approval code). `declined` needs a verifier prepared on this counter.

**What the server's acknowledgement means.** The server never marks an incident or card event
`accepted`: it stores it and answers `held` / `RECONCILIATION_REQUIRED` ("kept for review"), because
the sale and the card machine's result are checked online by a person. A drain that waited for
`accepted` would never finish, so:

| Server answer | Local status | Drain |
| --- | --- | --- |
| `accepted` / `duplicate` | `received` | delivered |
| `held` + `RECONCILIATION_REQUIRED` | `received` | delivered |
| `held` + `REPLAY_CONFLICT` (other content under the ID) | `refused`, never resent, issue shown on every cycle | holds until repaired |
| any other `held` | stays `pending`, sent again a minute later | holds |
| no acknowledgement for a record sent | stays `pending`, `SERVER_ERROR` issue | holds |

A reply that acknowledges a record that wasn't sent, twice, or with another hash is not trusted and
nothing in it is applied. The last-sync time moves only when every record sent has been delivered.

**Payments.** An attempt blocks the drain while its latest event is `prepared`, `uncertain` or
`approved` with no sale linked, besides the online sales still unconfirmed. `declined` and
`linked_to_sale` are settled.

Not built: any screen that calls the writers; the counter's "waiting on a payment" message (the
pause counts journal entries only, so a drain held by a card attempt shows no reason yet); manager
resolution of refused records in the back office.

## Later slices (not built)

- Backups somewhere other than the counter's own disk (another computer, removable media or the
  server). Today a computer that is lost or replaced has no backup to restore: it is enrolled
  anew, and D11's missing-journal sign-off covers its journal.
- Settling a recovery's unmatched entries in place (today the approver records how stock and
  cash were settled; the adjustment itself is a separate document).
- Support-record gating of dependent commands (held support records do not yet hold a sale).
  The desktop's support records and external-card attempts are written, uploaded and gate the
  drain (see "Support records and card attempts on the desktop").
- Sync lag visible centrally (server and web).
- The desktop producer (P4 #50): outage entry and offline selling. This slice's upload and drain
  are exercised with journals written by P4's writer in tests. P4 must also quiesce before the
  drain ends an outage: today one renewal that gets through can install a pair and end the outage
  at once, which is harmless while nothing sells offline. Once offline tender exists, the
  installer has to refuse (`drain_incomplete`) while an offline tender is open, and a flapping
  connection must not split one outage into two (epic: "a single probe cannot interrupt tender").
- A concrete retention policy for journal evidence (nothing is deleted today).

## Counter sync status for managers (built)

Until now only the counter knew how far its journal had reached the server (its readiness
Synchronisation row). Managers now see it per counter, from the server's own records.

| Area | What exists |
| --- | --- |
| Read | `GET /terminals/offline-journal/sync-status` (`tenant.management`, live at the branch): the branch's timezone and, per enrollment, the accepted head and when it was accepted, when an upload last brought something, where the journal stopped (the first refused entry past the head) and open stock cases. One statement over `terminal_command_receipt`, `offline_journal_review`, `offline_staff_sign_in` and `offline_stock_discrepancy`, every read scoped by tenant and branch; the head and the stopping point are shared SQL fragments (`journal/counter-journal-status.ts`) |
| Counters page | Settings → Counters has an "Offline sales" column: "All on the server, last received 14:02" or "Stopped at entry 42" with what moves it on (the counter repairs a held entry; a refused one needs review; a conflict needs journal recovery), a link to Inventory → Stock cases for open cases, and an earlier revoked key or retired computer of the same counter while its journal stops short. Times read in the branch's timezone, as Daily work does. A failed status read leaves the counters list working ("Couldn't check") |
| Daily work | `offline_journal.review`, "Review refused offline entry": a current counter stopped on a rejected entry, for `tenant.management`, linking to Counters |

### Decisions

- **The server's records, not the counter's word.** Nothing here is reported by the counter; it
  is what the server accepted and retained. So "all on the server" means every entry the counter
  has sent was accepted: a counter that is offline now may hold sales it hasn't sent yet, and the
  page says so.
- **"Last received", not "last sync".** It is the last upload that brought the server something
  new. An empty confirmation upload (slice 3 sends one every 5 minutes) writes nothing, so it
  can't be seen; the status stays read-only rather than writing on every upload.
- **Where it stopped, not how many wait.** Intake stops at the first refusal and retains only
  that entry, so the server holds nothing after it and can't count what follows. The status names
  the lowest refused sequence past the head (a conflicting copy before a rejected one before a
  held one). Refusals at or below the head are kept as evidence but are not status: a conflict on
  an accepted entry leaves the accepted one standing.
- **Daily work lists only what can be settled from it.** A held entry is the counter's to repair.
  A rejected one on a current counter is what slice 4 (#155) settles: its settlement writes the
  receipt at that sequence, the head moves past it and the item drops out. Conflicts, and revoked
  or retired counters, go to D11 journal recovery (#154), so they stay on the Counters page but
  are not listed as work nothing here clears.
- **Existing permission.** `tenant.management` is what the Counters page already requires. Slice
  4's `sales.review_offline_entries` is not in `develop` yet (a key outside the catalog is granted
  to nobody), so the Daily work source carries a TODO(#155) to switch to it and link
  `/inventory/offline-records`.
- This covers "sync lag visible centrally" from the later slices list.

### Tests

Unit: `journal/counter-journal-status.spec.ts` (row mapping, which enrollments are listed, every
read of every table in the status query and the Daily work source joined on the enrollment's
tenant and branch, the service's permission and timezone), `terminal-routes.spec.ts`,
`daily-work-kinds.spec.ts`. PostgreSQL: `test/integration/counter-journal-status.int-spec.ts` —
head and last receipt, a held entry stopping the journal until it is accepted, a rejected entry
stopping it (and the Daily work item, only with `tenant.management`), the tenant's other branch
seeing only its own computer and no item, a conflict at the head not counted, a fork past the
head stopping it but left out of Daily work, open stock cases, a revoked counter listed only
while its journal stops short, another tenant, and refusal without the permission. Web:
`settings/counters/page.spec.tsx`, `offline-sync.spec.tsx` (including branch-timezone times).
