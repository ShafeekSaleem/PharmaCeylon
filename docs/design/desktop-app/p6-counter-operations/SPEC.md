# P6 · Counter work operation screens

20 November 2026, Asia/Colombo. Fixture clock: Friday, 20 November 2026, 14:20. Kollupitiya · Counter 2, Sachini Rathnayake signed in with an open shift.

Mockups only. No product code. Audited against `develop` `419d16b`: `packages/shared/src/counter-work.ts`, `docs/COUNTER_WORK_COVERAGE.md`, and the controllers, DTOs and services behind each signed call.

## What every screen shares

- **The #122 frame.** The queue stays on the left; the operation opens on the right. The header names the document, and the trail shows who prepared or requested it, who approved which version, and you.
- **Approval check.** One line under the trail, from `task.approval.state`:
  - `matches`: a plain line, "Matches the approved version".
  - `changed`: the line turns into a warning, the changed lines are marked, and the main action is off (`rcv-changed`). This is the stale-evidence case (`APPROVAL_STALE`).
  - `revoked`: the same warning layout with nothing marked, "The approval was withdrawn on the web", and the main action off (`APPROVAL_INVALID`). Not drawn; it reuses `rcv-changed`.
  - `not_needed`: the trail has no approver step, and the line says what pins the post instead. Imports are pinned to the staged version (`imp`). A transfer out under a waived policy says "Approval isn't needed at this branch". A transfer in is pinned to the dispatch (`dispatchApprovalId`).
- **Fixed documents.** The counter confirms the document as it stands; it never edits quantities, batches or prices. Each post is a signed terminal command (`/terminal-commands/prepare`, then `execute`) whose body names only the document, with the approval pinned in `approvalEvidenceId`. The bodies are `{ preparedReceiptId }`, `{ heldDeliveryId }`, `{ transferId }` (out), `{ stocktakeId }` and `{ goodsReturnId }`. Only a transfer in takes counts (`{ transferId, dispatchApprovalId, lines: [{ transferItemId, qty, receivedQtyBefore }] }`), and only an import takes a choice (`{ importId, version, selection, categoryName }`). Undo is `{ importId }`. See `docs/API_CONTRACT.md`, "Signed terminal commands".
- **Local checklists.** Ticking lines (scan with F6, or Space) is a check kept on this computer, not sent. The main action stays off until every line is ticked. "Save, finish later" keeps the ticks. Each tick is kept against the line's content as approved, so when a corrected version comes back, ticks stay only on the lines it didn't change.
- **Response loss.** The counter keeps the signed command until it has a receipt or a definite refusal. If the answer is lost, it shows `tship-retry`: "Check again" resends that same signed command (same `commandId`), and the server replays the original receipt, so stock can't move twice. It never prepares a new command for a document while one is unresolved. The item shows "Checking" in the queue until it knows.
- **Done.** The trail closes with you and the time (`tship-done`), and the item moves to "Done at this counter today".
- **Costs.** Unit cost and value columns need `costs.view`, as on the web. Without it they are left out.
- **Online only.** As today, Counter work is read-only offline; none of these screens opens.

## What the API needs

The screens are drawn from documents the counter can't read yet. `GET /counter-work` carries only each item's header: reference, subject, line count, amount, who asked and who approved. The document detail routes are web routes, and a PIN-opened counter login is refused there (`COUNTER_SESSION_ONLY`). P6 needs:

1. **A counter read per kind**, marked `@CounterRoute()`, returning the lines each screen draws: products, batches, expiry, quantities, the trail and the approver's note. Costs are left out without `costs.view`. Refunds (`GET /sales/refund-requests`) and offline stock cases (`GET /offline-stock-cases/resolutions/ready`) already work this way.
2. **The mismatch endpoint** (decision 1).
3. **The stocktake posting change** (decision 3).
4. **A counter list of imports that can still be undone** (decision 5).
5. **Closing a short transfer on the web** (decision 2). This is a web route, not a counter one.

## Screens

1. **`rcv` Receive goods.** A delivery prepared on the web from the supplier's note. Packs, free packs, batch and expiry are the approved version. Tick each line as it is checked, then Post receiving.
2. **`rcv-mismatch` Something doesn't match.** Choose the line and what's wrong, add the count and a note, and send it to the approver. Nothing posts. The note lands in the approver's Daily work; the item waits for a corrected version and comes back with the ticks kept on the lines that version didn't change. **Needs a new endpoint (decision 1).**
3. **`rcv-changed` Changed after approval.** Version 4 was saved after Dilini F. approved version 3. Posting is off until version 4 is approved.
4. **`held` Post held delivery.** A delivery refused at receiving because it was over the order or the price went up. It was approved on the web, possibly corrected. The screen says why it was held and what was decided, then posts it. Damaged units go to quarantine in the same posting, and the summary shows the units added and the amount owed.
5. **`tship` Pick and dispatch.** The approval names the batches, so the pick list is fixed. Dispatch takes the stock out and puts it on the way.
6. **`tship-retry` No answer from the server.** See "Response loss" above.
7. **`tship-done` Dispatched.**
8. **`trecv` Receive transfer.** Count what arrived per line. Counts start empty; "Fill the rest as sent" fills only the lines not yet counted, and Receive stays off until every line has a count. Units not received stay on the way until they arrive or a manager closes the rest on the web (decision 2). A line received earlier shows "Already in".
9. **`stk` Post stock count.** Counted on phones and reviewed on the web. The counter posts the approved differences, as found at the count, so sales and deliveries since are kept. **Needs an API change (decision 3).**
10. **`sret` Hand over supplier return.** Pack each line, print the return note for the rep, then complete. Completing raises the debit note in the same transaction.
11. **`imp` Post opening stock.** A staged stock import. There is no approval step: the post is pinned to the staged version shown. Post one category, or the rest at once. Posted opening stock can't be undone; a correction is a stock adjustment.
12. **`imp-undo` Undo an import.** For an import uploaded with its stock. It removes the products the import created and every batch it posted, including stock it added to products it only updated. Those products stay, with the changes the import made. It is refused once anything from it has sold or moved. It opens from an Imports filter in Counter work (decision 5).

## Decisions (Shafeek, 20 Nov 2026)

1. **Something doesn't match goes to the approver.** A new endpoint records the line, what's wrong, the count and a note, and puts it in the approver's Daily work. The item waits at the counter for a corrected, re-approved version. The same applies to "Can't pick all of it" on a transfer out and to a held delivery. Nothing posts from the counter until then.
2. **A manager closes a short transfer on the web.** The remainder is closed with a reason: "never left the source" returns the units to the source branch's stock; "lost in transit" writes them off. Until then they stay on the way, and the counter can still receive them.
3. **Stocktake posting applies the difference found at the count.** Today the API sets each batch to the counted figure (counted − (snapshot + movements since)), which drops sales and deliveries made after the count. The API changes to post counted − (snapshot + movements between the snapshot and when that line was counted). Stocktakes run with sales continuing (`continue_and_reconcile`), so plain counted − snapshot would take sales made while counting off twice: snapshot 10, 2 sold before the shelf is counted, count 8, and the batch would end at 6. A line counted more than once uses its last count's time. An integration test proves today's behaviour first, then the fix.
4. **The signed paper return note is enough for v1.** The counter doesn't record the rep's name; the complete still sends only the approval.
5. **Imports filter in Counter work.** `import_undo` gets a filter that lists this branch's imports uploaded with their stock while undo is still allowed. It needs a new counter read. The web's `GET /products/import/history` isn't a counter route, and its `undoBlockedReason` is set ("Undo posted stock at the counter.") for exactly the imports this filter must list. The new read applies the same undo checks (`undoBlockedReason` in `product-import.service.ts`, and not posted from a staged draft) without that hand-off.

## Not drawn

- The refund, held write-off, offline stock case and supplier cash payout screens. They are already built.
- Quarantine and release from Stock, built in #173.
- The cold-chain check when receiving, in P8 #104.
