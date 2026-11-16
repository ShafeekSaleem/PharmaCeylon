import { randomUUID } from "node:crypto";
import { counter, offlineJournal, onHand, prisma, saleAck, sync } from "../offline-counter.kit";
import { onlineSale, reviewSet, statuses } from "./acceptance.kit";

/**
 * P5 #51 acceptance box A2 — fixture run of the contract's partial-partition scenario against the
 * journal sync endpoint: the offline counter last knew 10 units; 7 sell online meanwhile; it sells
 * 5 offline. The offline sale and its payment are kept, a 2-unit shortfall case opens, only the
 * affected batch is blocked, and unrelated stock stays sellable online and offline.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

describe("A2: partial partition — 10 last known, 7 sold online, 5 sold offline", () => {
  it("keeps the offline sale and payment, opens the shortfall case, blocks only the affected batch", async () => {
    const c = await counter({ partition: 10, unrelated: 20 });
    expect(c.snapshot.lines.find((l) => l.batchId === c.batches.partition)!.availableQuantity).toBe(10);

    // Online, while the counter is cut off.
    await onlineSale(c, c.batches.partition, 7);
    expect(await onHand(c.batches.partition)).toBe(3);

    // Offline: 5 from the partition batch, and a separate sale from unrelated stock.
    const j = offlineJournal(c);
    const cashierIn = j.signIn(c.cashier.userId, randomUUID());
    const open = j.open(cashierIn, 0);
    const shortSale = j.sale(cashierIn, [[c.batches.partition, 5]]);
    const fineSale = j.sale(cashierIn, [[c.batches.unrelated, 2]]);
    const response = await sync(c, { staffSignIns: [cashierIn], commands: [open, shortSale, fineSale] });
    expect(statuses(response.payload.acknowledgements)).toEqual(["committed", "committed", "committed"]);

    // The offline sale and its payment are kept as made, its stock pending.
    const short = saleAck(response.payload.acknowledgements[1]!);
    expect(short).toMatchObject({ stockPosting: "pending_reconciliation", reconciliationCaseId: expect.any(String) });
    const row = await prisma.sale.findUniqueOrThrow({ where: { id: short.saleId }, include: { payments: true, items: true } });
    expect(row).toMatchObject({ offlineCommandId: shortSale.payload.commandId, stockPosting: "pending_reconciliation" });
    expect(row.items.map((i) => [i.batchId, i.qty])).toEqual([[c.batches.partition, 5]]);
    // As online: cash is recorded as tendered, with the change given back beside it.
    const [cash] = shortSale.payload.payments;
    expect(cash).toMatchObject({ method: "cash" });
    expect(row.payments.map((p) => [p.method, p.amount.mul(100).toNumber()])).toEqual([["cash", (cash as { tenderedMinor: number }).tenderedMinor]]);
    expect(row.grandTotal.mul(100).toNumber()).toBe(shortSale.payload.totalMinor);
    expect(row.changeDue.mul(100).toNumber()).toBe((cash as { changeMinor: number }).changeMinor);
    // Nothing clamped or invented: the 3 central units are untouched and no sale_out posted.
    expect(await onHand(c.batches.partition)).toBe(3);
    expect(await prisma.stockLedger.count({ where: { tenantId: c.fx.tenantId, referenceId: short.saleId } })).toBe(0);

    // The shortfall case: 5 sold, 3 there at sync, 2 short.
    const discrepancy = await prisma.offlineStockDiscrepancy.findUniqueOrThrow({
      where: { id: short.reconciliationCaseId! }, include: { lines: true, blocks: true },
    });
    expect(discrepancy).toMatchObject({ status: "open", saleId: short.saleId });
    expect(discrepancy.lines).toEqual([expect.objectContaining({
      batchId: c.batches.partition, soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2, reason: "shortfall",
    })]);
    // Only the affected batch is blocked.
    expect(discrepancy.blocks.map((b) => [b.batchId, b.releasedAt])).toEqual([[c.batches.partition, null]]);
    expect(await prisma.batchSaleBlock.count({ where: { tenantId: c.fx.tenantId, releasedAt: null } })).toBe(1);
    expect(await reviewSet(c)).toEqual([c.batches.partition]);

    // The unrelated offline sale posted normally.
    expect(saleAck(response.payload.acknowledgements[2]!)).toMatchObject({ stockPosting: "posted" });
    expect(await onHand(c.batches.unrelated)).toBe(18);

    // Online: the blocked batch is refused, by name or by FEFO; unrelated stock still sells.
    await expect(onlineSale(c, c.batches.partition, 1)).rejects.toMatchObject({ response: { code: "BATCH_STOCK_REVIEW" } });
    const fefo = await onlineSale(c, undefined, 3);
    expect(fefo!.items.map((i) => i.batchId)).toEqual([c.batches.unrelated]);
    expect(await onHand(c.batches.unrelated)).toBe(15);

    // Offline, after the case: unrelated stock still posts; the blocked batch waits on review.
    const later = await sync(c, { commands: [j.sale(cashierIn, [[c.batches.unrelated, 1]]), j.sale(cashierIn, [[c.batches.partition, 1]])] });
    expect(saleAck(later.payload.acknowledgements[0]!)).toMatchObject({ status: "committed", stockPosting: "posted" });
    expect(saleAck(later.payload.acknowledgements[1]!)).toMatchObject({ status: "committed", stockPosting: "pending_reconciliation" });
    expect(await onHand(c.batches.unrelated)).toBe(14);
    expect(await onHand(c.batches.partition)).toBe(3);
  });
});
