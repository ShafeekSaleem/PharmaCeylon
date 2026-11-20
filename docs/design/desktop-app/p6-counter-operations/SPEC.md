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
2. **`rcv-mismatch` Something doesn't match.** Choose the line and what's wrong, add the count and a note, and send it to the approver. Nothing posts. The item waits for a corrected version and comes back with the ticks kept. **Needs an API (Q1).**
3. **`rcv-changed` Changed after approval.** Version 4 was saved after Dilini F. approved version 3. Posting is off until version 4 is approved.
4. **`held` Post held delivery.** A delivery refused at receiving because it was over the order or the price went up. It was approved on the web, possibly corrected. The screen says why it was held and what was decided, then posts it. Damaged units go to quarantine in the same posting, and the summary shows the units added and the amount owed.
5. **`tship` Pick and dispatch.** The approval names the batches, so the pick list is fixed. Dispatch takes the stock out and puts it on the way.
6. **`tship-retry` No answer from the server.** See "Response loss" above.
7. **`tship-done` Dispatched.**
8. **`trecv` Receive transfer.** Count what arrived per line. "Receive all as sent" fills the counts. Units not received stay on the way (Q2). A line received earlier shows "Already in".
9. **`stk` Post stock count.** Counted on phones and reviewed on the web. The counter posts the approved differences. It warns when stock moved since the count (Q3).
10. **`sret` Hand over supplier return.** Pack each line, print the return note for the rep, then complete. Completing raises the debit note in the same transaction.
11. **`imp` Post opening stock.** An approved stock import. Post one category, or the rest at once. Posted opening stock can't be undone; a correction is a stock adjustment.
12. **`imp-undo` Undo an import.** For an import uploaded with its stock. It removes the products the import created and their stock, and keeps products it only updated. It is refused once anything from it has sold or moved. Where the counter opens it is Q5.

## Questions for Shafeek

1. **Receiving can't change anything at the counter.** The post sends only the approval, so a short or damaged delivery can't be recorded here. Proposal: "Something doesn't match" sends a note to the approver through a small new endpoint, and the item waits for a corrected version. The alternative is no button, just "ask the manager". The same choice applies to "Can't pick all of it" on a transfer out and on a held delivery.
2. **A transfer that arrives short has no way to close.** The missing units stay on the way indefinitely. Proposal: the source branch or a manager closes the remainder on the web with a reason, and the units go back to the source's stock.
3. **Stocktake posting sets each batch to the counted figure.** The adjustment is counted − (snapshot + movements since), so sales after the count are not kept. Is that intended? If yes, the warning stays. If not, the API should apply only the difference found at count time.
4. **Who collected a supplier return isn't recorded.** The complete sends only the approval. Is the signed paper note enough, or should the counter record the rep's name?
5. **Where does the counter undo an import?** `import_undo` is a destination but not a Counter work kind, and the browser route sends people to the counter ("Undo it at the counter"). Proposal: an "Imports" filter in Counter work that lists this branch's imports with stock while undo is allowed.

## Not drawn

- The refund, held write-off, offline stock case and supplier cash payout screens. They are already built.
- Quarantine and release from Stock, built in #173.
- The cold-chain check when receiving, in P8 #104.
