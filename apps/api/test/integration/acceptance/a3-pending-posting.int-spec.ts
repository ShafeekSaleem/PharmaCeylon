import { randomUUID } from "node:crypto";
import { acceptedJournalState, issueOfflineAuthority } from "../../../src/terminals/offline-authority-issuance";
import { commandText, sha256 } from "../../../src/terminals/terminal-wire";
import { access, counter, offlineJournal, onHand, prisma, saleAck, signer, sync, type Counter } from "../offline-counter.kit";
import { branch, cases, effects, onlineSale, reviewSet, run, signedResolve } from "./acceptance.kit";

/**
 * P5 #51 acceptance box A3 — fixture run: a sale accepted with its stock pending advances the
 * journal watermark only together with its durable case and batch block; a fresh snapshot issued
 * over that watermark keeps the block; and the manager's resolution posts the sale's stock once.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

const freshAuthority = (c: Counter) => issueOfflineAuthority(prisma as never, access, {
  signer, defaultVatRatePercent: 18,
  authenticate: async () => ({ identity: c.identity, commandId: randomUUID() }),
  readState: acceptedJournalState,
});

describe("A3: a pending-posting case advances the watermark only with durable case and block state", () => {
  it("watermark, receipt, case and block are committed together; a fresh snapshot keeps the block; resolution posts once", async () => {
    const c = await counter({ partition: 10, other: 20 });
    await onlineSale(c, c.batches.partition, 7);
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const sale = j.sale(cashierIn, [[c.batches.partition, 5]]);
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    const ack = saleAck(response.payload.acknowledgements[1]!);
    expect(ack).toMatchObject({ status: "committed", stockPosting: "pending_reconciliation" });

    // The watermark moved past the pending sale...
    expect(response.payload.committedThroughSequence).toBe(2);
    expect(response.payload.committedThroughHash).toBe(sha256(commandText(sale.payload)));
    // ...and everything it stands on is already durable: receipt, sale, open case, active block.
    const receipt = await prisma.terminalCommandReceipt.findFirstOrThrow({
      where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId, offlineSequence: 2 },
    });
    expect(receipt).toBeDefined();
    const caseRow = await prisma.offlineStockDiscrepancy.findUniqueOrThrow({ where: { id: ack.reconciliationCaseId! }, include: { blocks: true } });
    expect(caseRow).toMatchObject({ status: "open", saleId: ack.saleId, commandId: sale.payload.commandId });
    expect(caseRow.blocks.map((b) => [b.batchId, b.releasedAt])).toEqual([[c.batches.partition, null]]);
    // The server's accepted state for this counter reads the same watermark and the same block.
    const state = await prisma.$transaction((tx) => acceptedJournalState(tx, c.identity));
    expect([...state.reviewRequiredBatchIds]).toEqual([c.batches.partition]);

    // A fresh snapshot over the new watermark: the posted batch is sellable, the pending one is not.
    for (const expectedVersion of [c.snapshot.snapshotVersion + 1, c.snapshot.snapshotVersion + 2]) {
      const renewed = (await freshAuthority(c)).snapshot.payload;
      expect(renewed).toMatchObject({
        snapshotVersion: expectedVersion, includedThroughSequence: 2, includedThroughHash: response.payload.committedThroughHash,
      });
      expect(renewed.lines.find((l) => l.batchId === c.batches.partition)).toMatchObject({ stockReviewRequired: true });
      expect(renewed.lines.find((l) => l.batchId === c.batches.other)).toMatchObject({ stockReviewRequired: false, availableQuantity: 20 });
    }
    expect(await prisma.batchSaleBlock.count({ where: { caseId: caseRow.id, releasedAt: null } })).toBe(1);

    // Manager resolution, retried concurrently at the counter: one settlement, one posting.
    const plan = await cases.prepare(c.manager, branch(c), caseRow.id, { kind: "count_and_correct" });
    const request = await signedResolve(c, c.manager, plan.id, [{ batchId: c.batches.partition, countedQty: 0 }], plan.executionApprovalId);
    const receipts = await Promise.all([1, 2, 3].map(() => run(c, c.manager, request)));
    expect(new Set(receipts.map((r) => r.receiptId)).size).toBe(1);
    expect(receipts.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.offlineStockSettlement.count({ where: { caseId: caseRow.id } })).toBe(1);
    expect((await prisma.stockLedger.findMany({ where: { tenantId: c.fx.tenantId, referenceId: ack.saleId } })).map((l) => l.qtyDelta)).toEqual([-5]);
    expect(await onHand(c.batches.partition)).toBe(0);

    // A new command for the executed plan is refused; nothing moves.
    await expect(run(c, c.manager, await signedResolve(c, c.manager, plan.id,
      [{ batchId: c.batches.partition, countedQty: 0 }], plan.executionApprovalId))).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });
    // The counter resends the original journal: still the original receipt, no second posting.
    const before = await effects(c);
    const resend = await sync(c, { staffSignIns: [cashierIn], commands: [open, sale] });
    expect(saleAck(resend.payload.acknowledgements[1]!)).toMatchObject({ status: "duplicate", saleId: ack.saleId });
    expect(await effects(c)).toEqual(before);
    expect(await onHand(c.batches.partition)).toBe(0);

    // Released: the next fresh snapshot no longer marks the batch.
    expect(await reviewSet(c)).toEqual([]);
    const after = (await freshAuthority(c)).snapshot.payload;
    expect(after.lines.find((l) => l.batchId === c.batches.partition)?.stockReviewRequired ?? false).toBe(false);
  });
});
