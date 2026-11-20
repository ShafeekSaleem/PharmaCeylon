# P6 · Counter work operation screens

20 November 2026, Asia/Colombo. Fixture clock: Friday, 20 November 2026, 14:20. Kollupitiya · Counter 2, Sachini Rathnayake signed in with an open shift.

Mockups only. No product code. Audited against `develop` `419d16b`: `packages/shared/src/counter-work.ts`, `docs/COUNTER_WORK_COVERAGE.md`, and the controllers, DTOs and services behind each signed call.

## What every screen shares

- **The #122 frame.** The queue stays on the left; the operation opens on the right. The header names the document, and the trail shows who prepared or requested it, who approved which version, and you.
- **Approval check.** A plain line, "Matches the approved version", when `task.approval.state` is `matches`. When it is `changed` the line turns into a warning, the changed lines are marked, and the main action is off (`rcv-changed`). This is the stale-evidence case (`APPROVAL_STALE`).
- **Fixed documents.** Prepared receipts, held deliveries, transfers out, stocktakes and supplier returns post with `{ approvalId }` and nothing else. The counter confirms the approved document; it never edits quantities, batches or prices. Only a transfer in takes counts (`lines[].qty` with `receivedQtyBefore`), and only an import takes a choice (`categoryName`).
- **Local checklists.** Ticking lines (scan with F6, or Space) is a check kept on this computer, not sent. The main action stays off until every line is ticked. "Save, finish later" keeps the ticks.
- **Response loss.** Every post sends an `Idempotency-Key`. If the answer is lost, the counter shows `tship-retry`: "Check again" resends the same request and gets the same result back, so stock can't move twice. The item shows "Checking" in the queue until it knows.
- **Done.** The trail closes with you and the time (`tship-done`), and the item moves to "Done at this counter today".
- **Costs.** Unit cost and value columns need `costs.view`, as on the web. Without it they are left out.
- **Online only.** As today, Counter work is read-only offline; none of these screens opens.

## Screens

1. **`rcv` Receive goods.** A delivery prepared on the web from the supplier's note. Packs, free packs, batch and expiry are the approved version. Tick each line as it is checked, then Post receiving.
2. **`rcv-mismatch` Something doesn't match.** Choose the line and what's wrong, add the count and a note, and send it to the approver. Nothing posts. The note lands in the approver's Daily work; the item waits for a corrected version and comes back with the ticks kept. **Needs a new endpoint (decision 1).**
3. **`rcv-changed` Changed after approval.** Version 4 was saved after Dilini F. approved version 3. Posting is off until version 4 is approved.
4. **`held` Post held delivery.** A delivery refused at receiving because it was over the order or the price went up. It was approved on the web, possibly corrected. The screen says why it was held and what was decided, then posts it. Damaged units go to quarantine in the same posting, and the summary shows the units added and the amount owed.
5. **`tship` Pick and dispatch.** The approval names the batches, so the pick list is fixed. Dispatch takes the stock out and puts it on the way.
6. **`tship-retry` No answer from the server.** See "Response loss" above.
7. **`tship-done` Dispatched.**
8. **`trecv` Receive transfer.** Count what arrived per line. "Receive all as sent" fills the counts. Units not received stay on the way until they arrive or a manager closes the rest on the web (decision 2). A line received earlier shows "Already in".
9. **`stk` Post stock count.** Counted on phones and reviewed on the web. The counter posts the approved differences, as found at the count, so sales and deliveries since are kept. **Needs an API change (decision 3).**
10. **`sret` Hand over supplier return.** Pack each line, print the return note for the rep, then complete. Completing raises the debit note in the same transaction.
11. **`imp` Post opening stock.** An approved stock import. Post one category, or the rest at once. Posted opening stock can't be undone; a correction is a stock adjustment.
12. **`imp-undo` Undo an import.** For an import uploaded with its stock. It removes the products the import created and their stock, and keeps products it only updated. It is refused once anything from it has sold or moved. It opens from an Imports filter in Counter work (decision 5).

## Decisions (Shafeek, 20 Nov 2026)

1. **Something doesn't match goes to the approver.** A new endpoint records the line, what's wrong, the count and a note, and puts it in the approver's Daily work. The item waits at the counter for a corrected, re-approved version. The same applies to "Can't pick all of it" on a transfer out and to a held delivery. Nothing posts from the counter until then.
2. **A manager closes a short transfer on the web.** The remainder is closed with a reason: "never left the source" returns the units to the source branch's stock; "lost in transit" writes them off. Until then they stay on the way, and the counter can still receive them.
3. **Stocktake posting applies the difference found at the count.** Today the API sets each batch to the counted figure (counted − (snapshot + movements since)), which drops sales and deliveries made after the count. The API changes to post counted − snapshot. An integration test proves today's behaviour first, then the fix.
4. **The signed paper return note is enough for v1.** The counter doesn't record the rep's name; the complete still sends only the approval.
5. **Imports filter in Counter work.** `import_undo` gets a filter that lists this branch's imports uploaded with their stock while undo is still allowed, using the existing undo-blocked reason to drop them.

## Not drawn

- The refund, held write-off, offline stock case and supplier cash payout screens. They are already built.
- Quarantine and release from Stock, built in #173.
- The cold-chain check when receiving, in P8 #104.
