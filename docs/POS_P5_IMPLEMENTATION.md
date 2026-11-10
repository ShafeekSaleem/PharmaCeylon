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
| Outcomes | `committed` / `duplicate` → `synced` with the acknowledgement kept; `held` stays `pending` and is resent after 60 s; `rejected` → `failed`, never resent, and nothing after it is sent. A lost reply is recovered by resending the same entries: the server answers `duplicate` |
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
  issued then could not include them), and a pair that is `behind` is not installed. The
  coordinator asks for one immediate renewal per outage and journal head, then the refresh's own
  back-off applies.
- **Finishing without a pair.** A counter that is no longer the offline counter, or whose branch
  no longer allows offline selling, will never get a rebased pair. Its drain ends once the
  journal is accepted and nothing sent is uncertain. Its old pair stays installed, unrenewed, and
  is soon too old to start another outage on.
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
  confirmation, replies with a bad signature or wrong content, a restored-backup mismatch, the
  drain's install ending the outage, `drain_incomplete`, a `behind` pair, and the coordinator
  (immediate renewal, finishing without a pair, never finishing with entries waiting).
- `checkout-service.spec.ts` covers `SYNC_PAUSED` with retry still working.
- `shell.spec.ts` covers the Synchronisation readiness row.
- `Shell.spec.tsx` covers `SyncBlock`.
- `migrations.integration.spec.ts` covers the upgrade from 14 to 15.
- `offline-authority*.spec.ts` covers the installer's new results.

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
| While open | Issuance and the challenge refuse `RECONCILIATION_REQUIRED` (`journalRecoveryOpen`) until the recovery is `recovered`. Nothing is posted: unmatched entries are evidence (`offline_journal_recovery_entry`), never sales or stock |
| Approval (web) | `GET /offline-journal-recoveries` (+ `/:id`) and `POST /:id/approve`, `tenant.management` plus revised D13 authority (owner, or a manager with a live delegation; else 403 `OFFLINE_ASSIGNMENT_NOT_DELEGATED`). The approver sees the unmatched entries (who, when, total, lines) and approves exactly them (`expectedServerHeadSequence`, `expectedUnmatched`) with a reason saying how their stock and cash were settled. Refused `_EVIDENCE_INCOMPLETE` until every page arrived |
| Apply (desktop) | `main/terminal/journal-recovery.ts`, run by the sync coordinator after each upload while `JOURNAL_MISMATCH` stands. In one SQLite transaction: unmatched entries move to `offline_journal_set_aside` (kept for good; delete and update abort), the server's entries after the common prefix are inserted as `synced`, the journal state and accepted watermark move to the server head, the installed pair and any pending renewal request are deleted, batch usage is reset and the issue cleared. Then a device-signed `offline_journal_recovery_completion` goes to `POST …/recovery/:id/complete`; the coordinator asks for a fresh pair at once |
| Stale | If the server's journal moves after the report (the original computer is still alive), approve, status and complete supersede the recovery and commit that before refusing `JOURNAL_RECOVERY_STALE`; the counter reports again by itself. If the counter recorded more offline sales since reporting, it reports again too |
| Sign-off (web) | `POST /offline-journal-recoveries/missing-journal`: owner or delegated manager, bound to the nomination version and accepted head shown (`expectedNominationVersion`, `expectedServerHeadSequence`), refused `JOURNAL_SIGN_OFF_TOO_EARLY` (with `availableAt`) before the last issued grant's `expiresAt`. A later sign-off supersedes the earlier one |
| Clearance | `OfflineActivationClearance.journalRecoveryEvidence` → `missingJournalEvidence`: a live sign-off for this nomination version whose head is still the accepted head and that was made at or after the last grant's expiry (so a renewal issued after it makes it stale). `D11_CLEARANCE_REQUIRED` carries `journalSignOffAvailableAt`; the activation audit records `journalSignOffId` |
| Schema | Migration `20261110000000_offline_journal_recovery`: `offline_journal_recovery` (shape checks per kind, approval whole or absent, one open restore per enrollment, a trigger allowing only forward transitions with content fixed) and `offline_journal_recovery_entry` (immutable). Desktop migration 17: `offline_journal_recovery` (the counter's current recovery, its stored signed report and completion) and `offline_journal_set_aside` |
| Back office | Settings → Offline policy → Offline counter journal (`journal-recovery-card.tsx`): the offline counter's accepted records, cutoff, retained refusals and sign-off state (and when a sign-off becomes possible), the sign-off form, restored counters waiting for approval with a review dialog, and earlier recoveries |
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
- **Stale is final.** A recovery or sign-off is bound to the server head (and, for a sign-off,
  the nomination version and the grants) it was made over; anything that moves them supersedes
  it and asks again, rather than approving something nobody looked at.

### Tests

API: `journal-recovery.spec.ts` (wire parsers, chain links, sign-off timing and staleness).
PostgreSQL: `offline-journal-recovery.int-spec.ts` covers the prefix restore end to end
(chain, report, refused issuance while open, D13 authority, completion and its replay, the
rebased pair, audit), the forked restore (paged evidence, contiguity, incomplete and stale
approvals, no sale or stock posted, immutable rows), report refusals and supersede on a moving
journal (including after approval), the revoked counter's sign-off waiting for its grant then
the replacement activating with `journalSignOffId`, and a sign-off going stale on new journal or
a renewal. `offline-activation.int-spec.ts` now clears a never-issued counter with a real
sign-off.

Desktop: `journal-recovery.spec.ts`, against a real encrypted store and a fake recovery server:
a prefix restore (waiting, approval, adopting the server entries, the grant removed, the drain
still waiting for a fresh pair), a forked restore with paged evidence and set-aside rows that
cannot be changed, a lost report reply and a lost completion resent unchanged, a moving server
journal reported again, withheld and forged chains refused, a journal that is only behind left to
the upload, and the coordinator renewing after completion. `migrations.integration.spec.ts`
covers the upgrade from 16 to 17.

Web: `journal-recovery-card.spec.tsx` (sign-off waiting for the grant, the exact sign-off body,
a stale sign-off, reviewing and approving exactly the unmatched records, a refusal kept in the
dialog). Shared: `offline-journal-recovery.test.cjs`.

## Later slices (not built)

- Review of a rejected journal entry, so a counter stuck on one can finish synchronising
  (today issuance stays `RECONCILIATION_REQUIRED` and the counter's drain waits).
- Making and restoring backups of the counter's store. D11 recovers whatever a restore brings
  back; nothing takes or restores a backup yet.
- Settling a recovery's unmatched entries in place (today the approver records how stock and
  cash were settled; the adjustment itself is a separate document).
- Support-record gating of dependent commands (held support records do not yet hold a sale), and
  the desktop's support records and external-card attempts. The drain treats both as resolved
  until P4 writes them.
- Sync lag visible centrally (server and web).
- The desktop producer (P4 #50): outage entry and offline selling. This slice's upload and drain
  are exercised with journals written by P4's writer in tests.
- A concrete retention policy for journal evidence (nothing is deleted today).
