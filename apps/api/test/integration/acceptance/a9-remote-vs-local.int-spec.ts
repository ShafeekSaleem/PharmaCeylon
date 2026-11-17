import { randomUUID } from "node:crypto";
import { StockCasesController } from "../../../src/stock-cases/stock-cases.controller";
import { counter, onHand, prisma, sync } from "../offline-counter.kit";
import {
  authorization, branch, cases, offlineSale, onlineSale, operations, RESOLVE, reviewSet, run, selfApproval, signedResolve,
} from "./acceptance.kit";

/**
 * P5 #51 acceptance box A9 — fixture run: a manager authorizes a stock case remotely, but the
 * physical correction can only be posted at the nominated counter; a material change to the case
 * invalidates the approval; local execution is idempotent and can't lift a batch block early.
 */
afterAll(async () => {
  await prisma.$disconnect();
});

describe("A9: remote authorization, local physical correction", () => {
  it("approves remotely, refuses a remote posting, and moves nothing until the counter executes", async () => {
    const c = await counter({ partition: 10, other: 20 });
    await onlineSale(c, c.batches.partition, 7);
    const { ack, j, cashierIn } = await offlineSale(c, [[c.batches.partition, 5]]);
    const caseId = ack.reconciliationCaseId!;

    // Remote authorization is allowed: the manager prepares, the owner approves from the back office.
    await selfApproval(c, ["owner"]);
    const plan = await cases.prepare(c.manager, branch(c), caseId, { kind: "count_and_correct" });
    const approved = await cases.approve(c.owner, branch(c), plan.id, { approvalId: randomUUID(), ...plan.approvalReview! });
    expect(approved).toMatchObject({ status: "approved", approvalState: "matches", readyAtCounter: true });
    expect(await onHand(c.batches.partition)).toBe(3);
    // Approval alone doesn't lift the block.
    expect(await reviewSet(c)).toEqual([c.batches.partition]);

    // Remote physical posting is rejected: the browser route, an unsigned request, and the offline journal.
    let refused: unknown;
    try {
      new StockCasesController(cases).execute(plan.id);
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ response: { code: "TERMINAL_REQUIRED" } });
    await expect(prisma.$transaction((tx) => authorization.authorize(tx, c.manager, branch(c), operations.get(RESOLVE).descriptor,
      { body: { resolutionId: plan.id, counts: [{ batchId: c.batches.partition, countedQty: 0 }] } })))
      .rejects.toMatchObject({ response: { code: "TERMINAL_REQUIRED" } });
    const smuggled = j.tamper(j.sale(cashierIn, [[c.batches.other, 1]]), { kind: "offline_stock_resolution" } as never);
    await expect(sync(c, { commands: [smuggled] })).rejects.toMatchObject({ status: 400 });
    expect(await onHand(c.batches.partition)).toBe(3);
    expect(await prisma.offlineStockSettlement.count({ where: { caseId } })).toBe(0);

    // At the counter it posts.
    const done = await run(c, c.manager, await signedResolve(c, c.manager, plan.id,
      [{ batchId: c.batches.partition, countedQty: 0 }], approved.executionApprovalId));
    expect(done.result).toMatchObject({ effect: "applied", batches: [{ correctionQty: 2, postedQty: 5, stillBlocked: false }] });
    expect(await prisma.offlineStockResolution.findUniqueOrThrow({ where: { id: plan.id } }))
      .toMatchObject({ requestedBy: c.manager.userId, approvedBy: c.owner.userId, executedBy: c.manager.userId });
    expect(await onHand(c.batches.partition)).toBe(0);
    expect(await reviewSet(c)).toEqual([]);
  });

  it("a material change invalidates the approval; local execution is idempotent and can't lift the block early", async () => {
    const c = await counter({ partition: 10 });
    await onlineSale(c, c.batches.partition, 7);
    const first = await offlineSale(c, [[c.batches.partition, 5]]);
    const caseA = first.ack.reconciliationCaseId!;
    const planA = await cases.prepare(c.manager, branch(c), caseA, { kind: "count_and_correct" });
    expect(planA).toMatchObject({ status: "approved", approvalState: "matches" });

    // Material change: another offline sale from the batch syncs and opens a second case.
    const caseB = (await offlineSale(c, [[c.batches.partition, 1]], first)).ack.reconciliationCaseId!;
    const stale = (await cases.detail(c.fx.tenantId, branch(c), caseA)).plans[0]!;
    expect(stale).toMatchObject({ approvalState: "changed", readyAtCounter: false });
    await expect(run(c, c.manager, await signedResolve(c, c.manager, planA.id,
      [{ batchId: c.batches.partition, countedQty: 0 }], planA.executionApprovalId)))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    expect(await onHand(c.batches.partition)).toBe(3);

    // Re-approved as now shown, then executed with concurrent retries: one receipt, one effect.
    const fresh = await cases.approve(c.manager, branch(c), planA.id, { approvalId: randomUUID(), ...stale.approvalReview! });
    const request = await signedResolve(c, c.manager, planA.id, [{ batchId: c.batches.partition, countedQty: 0 }], fresh.executionApprovalId);
    const receipts = await Promise.all([1, 2, 3, 4].map(() => run(c, c.manager, request)));
    expect(new Set(receipts.map((r) => r.receiptId)).size).toBe(1);
    expect(receipts.filter((r) => !r.replayed)).toHaveLength(1);
    expect(receipts.every((r) => JSON.stringify(r.result) === JSON.stringify(receipts[0]!.result))).toBe(true);
    expect(receipts[0]!.result).toMatchObject({ batches: [{ postedQty: 5, stillBlocked: true }] });
    expect(await prisma.offlineStockSettlement.count({ where: { caseId: caseA } })).toBe(1);
    expect(await onHand(c.batches.partition)).toBe(1);

    // Case B still holds the batch: not sellable, still marked in snapshots.
    expect(await reviewSet(c)).toEqual([c.batches.partition]);
    await expect(onlineSale(c, c.batches.partition, 1)).rejects.toMatchObject({ response: { code: "BATCH_STOCK_REVIEW" } });
    expect(await prisma.batchSaleBlock.count({ where: { caseId: caseB, releasedAt: null } })).toBe(1);

    const planB = await cases.prepare(c.manager, branch(c), caseB, { kind: "post_now" });
    await run(c, c.manager, await signedResolve(c, c.manager, planB.id, [], planB.executionApprovalId));
    expect(await onHand(c.batches.partition)).toBe(0);
    expect(await reviewSet(c)).toEqual([]);
  });
});
