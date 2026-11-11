import { randomUUID } from "node:crypto";
import { RoleName, StockMovementType } from "@prisma/client";
import type { OnlineTerminalCommand, SignedPhysicalOperation } from "@pharmaceylon/shared";
import { DailyWorkService } from "../../src/dashboard/daily-work.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../src/security/operation-authorization.service";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { StockCasesController } from "../../src/stock-cases/stock-cases.controller";
import { StockCasesService } from "../../src/stock-cases/stock-cases.service";
import { CounterWorkService } from "../../src/terminal-commands/counter-work.service";
import { SignedOperations } from "../../src/terminal-commands/signed-operations";
import { TerminalCommandExecutor } from "../../src/terminal-commands/terminal-command.executor";
import { acceptedJournalState } from "../../src/terminals/offline-authority-issuance";
import {
  access,
  attest,
  audit,
  counter,
  offlineJournal,
  onHand,
  prisma,
  proofs,
  sales,
  saleAck,
  stock,
  sync,
  trust,
  type Counter,
} from "./offline-counter.kit";

/** P5 #51 slice 2: offline stock discrepancy cases reviewed and approved remotely, resolved at the counter. */
class OpenHours extends MandatoryOperationEvidence {
  override async hours() {}
}
const approvals = new ManagementApprovalsService(access, audit);
const cases = new StockCasesService(prisma as never, audit, access, approvals, stock);
const authorization = new OperationAuthorizationService(access, trust, new OpenHours({} as never, {} as never), approvals);
const operations = new SignedOperations({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  {} as never, {} as never, {} as never, {} as never, cases);
const executor = new TerminalCommandExecutor(prisma as never, trust, authorization, operations, audit, access);
// The counter list reads cached grants, so it needs the real permissions resolver.
const listingAccess = new AccessService(prisma as never, new PermissionsService(prisma as never, { get: () => undefined } as never));
const work = new CounterWorkService(prisma as never, listingAccess, { list: async () => [] } as never, cases);
const RESOLVE = "POST /api/v1/offline-stock-cases/resolutions/:id/execute" satisfies SignedPhysicalOperation;
type Counts = Array<{ batchId: string; countedQty: number }>;

const branch = (c: Counter) => c.fx.mainBranchId;
/** The counter list reads the caller's cached branch roles, as a signed-in token carries them. */
const listedFor = (c: Counter) =>
  work.list({ ...c.manager, branchRoles: [{ branchId: branch(c), role: RoleName.manager, roleId: null }] } as RequestUser, branch(c));

/** The staff member's open session at the nominated counter, opened (attended) if needed. */
async function sessionFor(c: Counter, staff: RequestUser) {
  const open = await prisma.terminalStaffSession.findFirst({
    where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId, staffUserId: staff.userId, closedAt: null },
  });
  if (open) return open.id;
  const payload = await prisma.$transaction((t) => trust.beginSession(t, staff, branch(c), c.identity));
  const a = attest(c.fx, payload, "session", staff);
  const proof = await proofs.record(staff, branch(c), c.device.sign(a, c.identity.keyId, "attendance"));
  const { workSessionId } = await prisma.$transaction((t) =>
    trust.finishSession(t, staff, branch(c), c.device.sign(payload, c.identity.keyId), proof.proofId));
  return workSessionId;
}

/** A signed, attended command to execute `resolutionId` at the nominated counter. */
async function signedResolve(c: Counter, staff: RequestUser, resolutionId: string, counts: Counts, approvalId: string | null) {
  const workSessionId = await sessionFor(c, staff);
  const payload = await executor.prepare(staff, branch(c), {
    workSessionId, operation: RESOLVE, body: { resolutionId, counts }, approvalEvidenceId: approvalId,
    pharmacistEvidenceId: null, operatingHoursExceptionId: null,
  }) as OnlineTerminalCommand<unknown>;
  const a = attest(c.fx, payload, "command", staff);
  const proof = await proofs.record(staff, branch(c), c.device.sign(a, c.identity.keyId, "attendance"));
  return { command: c.device.sign(payload, c.identity.keyId), attendanceProofId: proof.proofId };
}
const run = (c: Counter, staff: RequestUser, request: unknown) => executor.execute(staff, branch(c), request);

type Journal = { j: ReturnType<typeof offlineJournal>; cashierIn: ReturnType<ReturnType<typeof offlineJournal>["signIn"]> };
/** One offline sale synced from the nominated counter: the first opens the offline shift, later
 * ones (`on`) continue that journal and shift. */
async function offlineSale(c: Counter, items: Array<[string, number]>, on?: Journal) {
  if (on) {
    const response = await sync(c, { commands: [on.j.sale(on.cashierIn, items)] });
    return { ...on, ack: saleAck(response.payload.acknowledgements[0]!) };
  }
  const j = offlineJournal(c);
  const cashierIn = j.signIn(c.cashier.userId, randomUUID());
  const response = await sync(c, { staffSignIns: [cashierIn], commands: [j.open(cashierIn, 0), j.sale(cashierIn, items)] });
  return { ack: saleAck(response.payload.acknowledgements[1]!), j, cashierIn };
}

const onlineSale = (c: Counter, batchId: string, qty: number) =>
  sales.checkout(c.fx.tenantId, branch(c), c.owner.userId, [],
    { items: [{ productId: c.fx.productId, batchId, qty, unitPrice: "15.50" }] } as never, undefined);

const reviewSet = async (c: Counter) =>
  [...(await prisma.$transaction((tx) => acceptedJournalState(tx, { ...c.identity, enrollmentId: randomUUID() }))).reviewRequiredBatchIds].sort();

/** A case's daily work item for someone who both reviews and manages inventory. */
const workItem = async (c: Counter, caseId: string) =>
  (await new DailyWorkService(prisma as never, { resolve: async () => ({ canSelfApprove: true, has: () => true }) } as never)
    .get(c.manager, branch(c), { filter: "all", category: "inventory", page: 1 } as never, { pageSize: 200 }))
    .items.find((item) => item.id === `stock_case:${caseId}`);

const batchStock = (batchId: string) => prisma.batchStock.findUniqueOrThrow({ where: { batchId } });

async function selfApproval(c: Counter, roles: string[]) {
  await prisma.tenantSettings.upsert({
    where: { tenantId: c.fx.tenantId },
    create: { tenantId: c.fx.tenantId, selfApprovalRoleKeys: roles },
    update: { selfApprovalRoleKeys: roles },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("offline stock case resolution (P5 #51)", () => {
  it("the contract's 10/7/5: approved remotely, refused remotely and offline, resolved by a count at the counter", async () => {
    const c = await counter({ partition: 10, other: 20 });
    await onlineSale(c, c.batches.partition, 7);
    const { ack, j, cashierIn } = await offlineSale(c, [[c.batches.partition, 5]]);
    const caseId = ack.reconciliationCaseId!;
    expect(await onHand(c.batches.partition)).toBe(3);

    // Review: the evidence a manager decides on.
    const detail = await cases.detail(c.fx.tenantId, branch(c), caseId);
    expect(detail.sale).toMatchObject({ id: ack.saleId, stockPosting: "pending_reconciliation", payments: [expect.objectContaining({ method: "cash" })] });
    expect(detail.offline).toMatchObject({ commandId: expect.any(String), signIn: { staff: { id: c.cashier.userId } }, uploadedBy: { id: c.cashier.userId } });
    const [line] = detail.batches;
    expect(line).toMatchObject({
      batchId: c.batches.partition, soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2, blocked: true,
      pending: { thisCase: 5, total: 5 }, stock: { onHand: 3, available: 3 },
    });
    // The online sale of 7 since the snapshot is on the batch's timeline, labelled with its invoice.
    expect(line!.timeline).toEqual([expect.objectContaining({ movementType: "sale_out", qtyDelta: -7, referenceType: "sale" })]);
    expect(line!.timelineDigest).toMatch(/^[0-9a-f]{64}$/);

    // The manager prepares; with self-approval off for managers, the owner approves remotely.
    await selfApproval(c, ["owner"]);
    const plan = await cases.prepare(c.manager, branch(c), caseId, { kind: "count_and_correct", note: "Count the shelf" });
    expect(plan).toMatchObject({ status: "prepared", approvalState: "none", approvalReview: { expectedVersion: 1 } });
    await expect(cases.approve(c.manager, branch(c), plan.id, { approvalId: randomUUID(), ...plan.approvalReview! }))
      .rejects.toThrow("can't approve its own requests");
    const approved = await cases.approve(c.owner, branch(c), plan.id, { approvalId: randomUUID(), ...plan.approvalReview! });
    expect(approved).toMatchObject({ status: "approved", approvalState: "matches", readyAtCounter: true, approver: { id: c.owner.userId } });
    // Approval moved nothing.
    expect(await onHand(c.batches.partition)).toBe(3);
    expect(await reviewSet(c)).toEqual([c.batches.partition]);

    // Remote: the browser route and an unsigned request are refused.
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
    // Offline: a resolution is not an offline journal command; the upload is refused whole.
    const smuggled = j.tamper(j.sale(cashierIn, [[c.batches.other, 1]]), { kind: "offline_stock_resolution" } as never);
    await expect(sync(c, { commands: [smuggled] })).rejects.toMatchObject({ status: 400 });

    // The counter lists it, matching the approved version.
    const listed = (await listedFor(c)).find((item) => item.id === plan.id);
    expect(listed).toMatchObject({ kind: "stock_case", approval: { state: "matches", evidenceId: approved.executionApprovalId } });
    const ready = await cases.readyAtCounter(c.fx.tenantId, branch(c));
    expect(ready[0]).toMatchObject({ kind: "count_and_correct", lines: [{ batchId: c.batches.partition, soldQuantity: 5 }] });
    expect(ready[0]!.lines[0]).not.toHaveProperty("onHand");

    // At the counter: the shelf is empty. The correction makes central 0 + 5 pending = 5, then the
    // sale posts its 5: central equals the count, with the online 7 and the offline 5 each once.
    const receipt = await run(c, c.manager, await signedResolve(c, c.manager, plan.id,
      [{ batchId: c.batches.partition, countedQty: 0 }], approved.executionApprovalId));
    expect(receipt.result).toMatchObject({
      type: "offline_stock_case.resolved", caseId, saleId: ack.saleId, kind: "count_and_correct", effect: "applied",
      batches: [{ batchId: c.batches.partition, method: "counted", soldQty: 5, countedQty: 0, correctionQty: 2, postedQty: 5, stillBlocked: false }],
    });
    expect(await onHand(c.batches.partition)).toBe(0);
    const ledger = await prisma.stockLedger.findMany({ where: { tenantId: c.fx.tenantId, batchId: c.batches.partition }, orderBy: { createdAt: "asc" } });
    expect(ledger.filter((l) => l.referenceId === ack.saleId).map((l) => [l.movementType, l.qtyDelta, l.occurredAt.getTime()]))
      .toEqual([["sale_out", -5, (await prisma.sale.findUniqueOrThrow({ where: { id: ack.saleId } })).soldAt.getTime()]]);
    expect(ledger.filter((l) => l.referenceType === "offline_stock_resolution").map((l) => [l.movementType, l.qtyDelta]))
      .toEqual([["adjustment_in", 2]]);

    expect(await prisma.sale.findUniqueOrThrow({ where: { id: ack.saleId } })).toMatchObject({ stockPosting: "posted" });
    expect(await prisma.offlineStockDiscrepancy.findUniqueOrThrow({ where: { id: caseId } })).toMatchObject({ status: "resolved" });
    expect(await prisma.batchSaleBlock.count({ where: { caseId, releasedAt: null } })).toBe(0);
    expect(await prisma.offlineStockSettlement.findFirstOrThrow({ where: { caseId } })).toMatchObject({
      method: "counted", soldQuantity: 5, onHandBefore: 3, pendingOnBatch: 5, countedQuantity: 0, countedBy: c.manager.userId,
      correctionQuantity: 2, postedQuantity: 5, approvalId: approved.executionApprovalId, executionCommandId: receipt.commandId,
    });
    // Requester, approver and executor are recorded separately.
    expect(await prisma.offlineStockResolution.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({
      status: "executed", requestedBy: c.manager.userId, approvedBy: c.owner.userId, executedBy: c.manager.userId,
      executionCommandId: receipt.commandId,
    });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, eventName: "offline_stock_discrepancy.resolved" } });
    expect(event.payload).toMatchObject({ requestedByUserId: c.manager.userId, approvedByUserId: c.owner.userId, executedByUserId: c.manager.userId });

    // New snapshots no longer mark the batch; central checkout sells from it again.
    expect(await reviewSet(c)).toEqual([]);
    await prisma.$transaction((t) => stock.receive(t,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 4, movementType: StockMovementType.purchase_in }]));
    await onlineSale(c, c.batches.partition, 1);

    // The resolved sale refunds normally: 2 units back on the shelf.
    const owner = await prisma.$transaction((t) => access.resolveLive(c.owner, branch(c), t));
    await sales.refundSale(c.fx.tenantId, branch(c), c.owner.userId, owner, ack.saleId,
      { reasonCode: "damaged", items: [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 2 }] } as never);
    expect(await onHand(c.batches.partition)).toBe(0 + 4 - 1 + 2);
  });

  it("a second open case on the batch makes the approval stale, and keeps the block until it is resolved too", async () => {
    const c = await counter({ partition: 10 });
    await onlineSale(c, c.batches.partition, 7);
    const first = await offlineSale(c, [[c.batches.partition, 5]]);
    const caseA = first.ack.reconciliationCaseId!;
    // Owners and managers approve their own plans by default: preparing approves it.
    const planA = await cases.prepare(c.manager, branch(c), caseA, { kind: "count_and_correct" });
    expect(planA).toMatchObject({ status: "approved", approvalState: "matches", requester: { id: c.manager.userId }, approver: { id: c.manager.userId } });

    // Another offline sale from the same batch syncs: a second case now holds it.
    const second = (await offlineSale(c, [[c.batches.partition, 1]], first)).ack;
    const caseB = second.reconciliationCaseId!;

    // The approved content included the batch's other open cases: it changed, so it is refused.
    const stale = (await cases.detail(c.fx.tenantId, branch(c), caseA)).plans[0]!;
    expect(stale).toMatchObject({ approvalState: "changed", readyAtCounter: false });
    expect((await listedFor(c)).find((i) => i.id === planA.id)).toMatchObject({ approval: { state: "changed" } });
    // It goes back to reviewers' daily work, not on to the counter team.
    expect(await workItem(c, caseA)).toMatchObject({ kind: "offline_stock_case.review", title: "Approve stock case plan again" });
    await expect(run(c, c.manager, await signedResolve(c, c.manager, planA.id,
      [{ batchId: c.batches.partition, countedQty: 0 }], planA.executionApprovalId)))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    expect(await onHand(c.batches.partition)).toBe(3);

    // Fresh approval of what is shown now, then the count: 0 on the shelf. Central becomes
    // 0 + 5 + 1 pending, the first sale posts 5, and case B's 1 unit is still owed.
    const fresh = await cases.approve(c.manager, branch(c), planA.id, { approvalId: randomUUID(), ...stale.approvalReview! });
    expect(await workItem(c, caseA)).toMatchObject({ kind: "offline_stock_case.resolve" });
    const done = await run(c, c.manager, await signedResolve(c, c.manager, planA.id,
      [{ batchId: c.batches.partition, countedQty: 0 }], fresh.executionApprovalId));
    expect(done.result).toMatchObject({ batches: [{ correctionQty: 3, postedQty: 5, stillBlocked: true }] });
    expect(await onHand(c.batches.partition)).toBe(1);
    // Case B still holds the batch: still blocked at checkout and in snapshots.
    expect(await reviewSet(c)).toEqual([c.batches.partition]);
    await expect(onlineSale(c, c.batches.partition, 1)).rejects.toMatchObject({ response: { code: "BATCH_STOCK_REVIEW" } });
    await expect(sales.voidSale(c.fx.tenantId, branch(c), c.owner.userId,
      [{ branchId: branch(c), role: RoleName.owner }], second.saleId, "test")).rejects.toMatchObject({ response: { code: "STOCK_POSTING_PENDING" } });

    // Case B: the stock the count accounted for covers it now, so it posts as it is.
    const planB = await cases.prepare(c.manager, branch(c), caseB, { kind: "post_now" });
    const doneB = await run(c, c.manager, await signedResolve(c, c.manager, planB.id, [], planB.executionApprovalId));
    expect(doneB.result).toMatchObject({ kind: "post_now", batches: [{ method: "posted", postedQty: 1, stillBlocked: false }] });
    // Central equals the count: no unit was deducted twice or invented.
    expect(await onHand(c.batches.partition)).toBe(0);
    expect(await reviewSet(c)).toEqual([]);
    expect(await prisma.batchSaleBlock.count({ where: { tenantId: c.fx.tenantId, releasedAt: null } })).toBe(0);
  });

  it("executes once under concurrent retries; a retry returns the original receipt and a new command changes nothing", async () => {
    const c = await counter({ main: 10 });
    await onlineSale(c, c.batches.main, 8);
    const { ack } = await offlineSale(c, [[c.batches.main, 4]]);
    const plan = await cases.prepare(c.manager, branch(c), ack.reconciliationCaseId!, { kind: "count_and_correct" });
    const request = await signedResolve(c, c.manager, plan.id, [{ batchId: c.batches.main, countedQty: 1 }], plan.executionApprovalId);

    const receipts = await Promise.all([1, 2, 3, 4].map(() => run(c, c.manager, request)));
    expect(new Set(receipts.map((r) => r.receiptId)).size).toBe(1);
    expect(receipts.filter((r) => !r.replayed)).toHaveLength(1);
    expect(receipts.every((r) => JSON.stringify(r.result) === JSON.stringify(receipts[0]!.result))).toBe(true);
    // 2 on hand, count 1 + 4 pending → +3, sale −4 → 1.
    expect(await onHand(c.batches.main)).toBe(1);
    expect(await prisma.offlineStockSettlement.count({ where: { caseId: ack.reconciliationCaseId! } })).toBe(1);
    expect(await prisma.stockLedger.count({ where: { tenantId: c.fx.tenantId, referenceId: { in: [ack.saleId, plan.id] } } })).toBe(2);

    // A distinct later command finds the plan executed: refused, nothing moves.
    await expect(run(c, c.manager, await signedResolve(c, c.manager, plan.id,
      [{ batchId: c.batches.main, countedQty: 1 }], plan.executionApprovalId))).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });
    expect(await onHand(c.batches.main)).toBe(1);
  });

  it("links a stocktake that already counted the sold units instead of posting them again", async () => {
    const c = await counter({ partition: 10 });
    await onlineSale(c, c.batches.partition, 7);
    const before = new Date();
    const { ack } = await offlineSale(c, [[c.batches.partition, 5]]);
    const caseId = ack.reconciliationCaseId!;
    const soldAt = (await prisma.sale.findUniqueOrThrow({ where: { id: ack.saleId } })).soldAt;

    // A stocktake counted the empty shelf after the offline sale and posted: central 3 → 0.
    const stocktake = async (countedAt: Date) => {
      const id = randomUUID();
      await prisma.stocktake.create({
        data: {
          id, tenantId: c.fx.tenantId, branchId: branch(c), stocktakeNumber: `ST-${id.slice(0, 6)}`, status: "approved",
          countedBy: c.manager.userId,
          lines: { create: { tenantId: c.fx.tenantId, productId: c.fx.productId, batchId: c.batches.partition, systemQty: 3,
            countedQty: 0, varianceQty: -3, status: "posted", countedAt, postedAt: countedAt } },
        },
      });
      await prisma.stocktake.update({ where: { id }, data: { status: "completed", postedAt: countedAt, completedAt: countedAt } });
      return id;
    };
    const early = await stocktake(new Date(Math.min(before.getTime(), soldAt.getTime()) - 60_000));
    // A post_now plan approved before the late count posted...
    const postNow = await cases.prepare(c.manager, branch(c), caseId, { kind: "post_now" });
    const late = await stocktake(new Date(soldAt.getTime() + 60_000));
    await prisma.$transaction((t) => stock.issue(t,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.manager.userId, referenceType: "stocktake", referenceId: late },
      [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 3, movementType: StockMovementType.stocktake_out }]));
    expect(await onHand(c.batches.partition)).toBe(0);
    const detail = await cases.detail(c.fx.tenantId, branch(c), caseId);
    expect(detail.batches[0]!.stocktakes.find((s) => s.stocktakeId === late)).toMatchObject({ settlesThisSale: true });
    expect(detail.batches[0]!.stocktakes.find((s) => s.stocktakeId === early)?.settlesThisSale ?? false).toBe(false);

    // ...is refused at the counter, under the batch locks: the count already took the sold units
    // off, so posting them would deduct them twice. Nor can it be prepared again.
    await expect(run(c, c.manager, await signedResolve(c, c.manager, postNow.id, [], postNow.executionApprovalId)))
      .rejects.toMatchObject({ response: { code: "SETTLEMENT_ALREADY_COUNTED" } });
    expect(await prisma.offlineStockDiscrepancy.findUniqueOrThrow({ where: { id: caseId } })).toMatchObject({ status: "open" });
    await cases.cancel(c.manager, branch(c), postNow.id);
    await expect(cases.prepare(c.manager, branch(c), caseId, { kind: "post_now" }))
      .rejects.toMatchObject({ response: { code: "SETTLEMENT_ALREADY_COUNTED" } });
    // A count from before the sale cannot account for it.
    await expect(cases.prepare(c.manager, branch(c), caseId, {
      kind: "link_existing_settlement", links: [{ batchId: c.batches.partition, source: "stocktake", stocktakeId: early }],
    })).rejects.toMatchObject({ response: { code: "SETTLEMENT_NOT_LINKABLE" } });

    const plan = await cases.prepare(c.manager, branch(c), caseId, {
      kind: "link_existing_settlement", links: [{ batchId: c.batches.partition, source: "stocktake", stocktakeId: late }],
    });
    const done = await run(c, c.manager, await signedResolve(c, c.manager, plan.id, [], plan.executionApprovalId));
    expect(done.result).toMatchObject({ kind: "link_existing_settlement", batches: [{ method: "linked", postedQty: 0, correctionQty: 0 }] });
    // Linked, not posted: no second deduction of the units the count already took off.
    expect(await onHand(c.batches.partition)).toBe(0);
    expect(await prisma.stockLedger.count({ where: { tenantId: c.fx.tenantId, referenceId: ack.saleId } })).toBe(0);
    expect(await prisma.offlineStockSettlement.findFirstOrThrow({ where: { caseId } }))
      .toMatchObject({ method: "linked", linkedStocktakeId: late, postedQuantity: 0 });
    expect(await prisma.sale.findUniqueOrThrow({ where: { id: ack.saleId } })).toMatchObject({ stockPosting: "posted" });
    expect(await reviewSet(c)).toEqual([]);
  });

  it("links a write-off's units once only, and posts now once a receipt covers the sale", async () => {
    const c = await counter({ main: 6, spare: 10 });
    const first = await offlineSale(c, [[c.batches.main, 2], [c.batches.spare, 1]]);
    // That first sale posts; then 3 sell online, leaving 1, and the next offline sale of 2 is short.
    await onlineSale(c, c.batches.main, 3);
    const later = await offlineSale(c, [[c.batches.main, 2]], first);
    expect(later.ack.stockPosting).toBe("pending_reconciliation");
    expect(first.ack.stockPosting).toBe("posted");
    // 3 arrive, then 2 are written off as missing from the shelf: the units the sale took.
    await prisma.$transaction((t) => stock.receive(t,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: c.fx.productId, batchId: c.batches.main, qty: 3, movementType: StockMovementType.adjustment_in }]));
    const writeOffRef = randomUUID();
    const laterSoldAt = (await prisma.sale.findUniqueOrThrow({ where: { id: later.ack.saleId } })).soldAt;
    await prisma.$transaction((t) => stock.issue(t,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.fx.ownerId, referenceType: "adjustment", referenceId: writeOffRef,
        // After the sale (the fixture's offline clock runs a little ahead of the wall clock).
        occurredAt: new Date(laterSoldAt.getTime() + 60_000) },
      [{ productId: c.fx.productId, batchId: c.batches.main, qty: 2, movementType: StockMovementType.adjustment_out, reason: "Missing from shelf" }]));
    const writeOff = await prisma.stockLedger.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, referenceId: writeOffRef } });
    const caseId = later.ack.reconciliationCaseId!;
    const detail = await cases.detail(c.fx.tenantId, branch(c), caseId);
    expect(detail.batches[0]!.movementCandidates).toEqual([expect.objectContaining({ ledgerEntryId: writeOff.id, remaining: 2 })]);

    const plan = await cases.prepare(c.manager, branch(c), caseId, {
      kind: "link_existing_settlement", links: [{ batchId: c.batches.main, source: "movements", ledgerEntryIds: [writeOff.id] }],
    });
    await run(c, c.manager, await signedResolve(c, c.manager, plan.id, [], plan.executionApprovalId));
    expect(await prisma.offlineStockSettlementLink.findMany({ where: { ledgerEntryId: writeOff.id } }))
      .toEqual([expect.objectContaining({ quantity: 2 })]);
    expect(await onHand(c.batches.main)).toBe(2);

    // One more sells online; the next offline sale from main is short again (its snapshot allowed
    // it), and the same write-off is already used up.
    await onlineSale(c, c.batches.main, 1);
    const third = await offlineSale(c, [[c.batches.main, 2]], first);
    const thirdCase = third.ack.reconciliationCaseId!;
    await expect(cases.prepare(c.manager, branch(c), thirdCase, {
      kind: "link_existing_settlement", links: [{ batchId: c.batches.main, source: "movements", ledgerEntryIds: [writeOff.id] }],
    })).rejects.toMatchObject({ response: { code: "SETTLEMENT_NOT_LINKABLE" } });
    // A receipt arrives; stock now covers the sale and it posts as it is.
    await prisma.$transaction((t) => stock.receive(t,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: c.fx.productId, batchId: c.batches.main, qty: 10, movementType: StockMovementType.purchase_in }]));
    const postNow = await cases.prepare(c.manager, branch(c), thirdCase, { kind: "post_now" });
    await run(c, c.manager, await signedResolve(c, c.manager, postNow.id, [], postNow.executionApprovalId));
    expect(await onHand(c.batches.main)).toBe(2 - 1 + 10 - 2);
    expect(await reviewSet(c)).toEqual([]);
  });

  it("one case resolving leaves another's approval standing, and its count correction is never linkable", async () => {
    const c = await counter({ partition: 10 });
    await onlineSale(c, c.batches.partition, 7);
    const first = await offlineSale(c, [[c.batches.partition, 5]]);
    const caseA = first.ack.reconciliationCaseId!;
    const caseB = (await offlineSale(c, [[c.batches.partition, 1]], first)).ack.reconciliationCaseId!;
    // 10 arrive: central 13, though the shelf holds 2 once both offline sales left it.
    await prisma.$transaction((t) => stock.receive(t,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: c.fx.productId, batchId: c.batches.partition, qty: 10, movementType: StockMovementType.purchase_in }]));
    // Both plans approved (self-approved) while both cases are open.
    const planA = await cases.prepare(c.manager, branch(c), caseA, { kind: "count_and_correct" });
    const planB = await cases.prepare(c.manager, branch(c), caseB, { kind: "count_and_correct" });

    // A is counted: 2 + 6 pending = 8, so -5, then A posts 5. Central 3 = the count + B's 1.
    const doneA = await run(c, c.manager, await signedResolve(c, c.manager, planA.id,
      [{ batchId: c.batches.partition, countedQty: 2 }], planA.executionApprovalId));
    expect(doneA.result).toMatchObject({ batches: [{ correctionQty: -5, postedQty: 5, stillBlocked: true }] });
    expect(await onHand(c.batches.partition)).toBe(3);

    // A leaving does not change what B's approval covered: B is still ready at the counter.
    expect((await cases.detail(c.fx.tenantId, branch(c), caseB)).plans[0]).toMatchObject({ approvalState: "matches", readyAtCounter: true });
    expect((await cases.readyAtCounter(c.fx.tenantId, branch(c))).find((p) => p.resolutionId === planB.id)).toMatchObject({ approvalState: "matches" });
    expect(await workItem(c, caseB)).toMatchObject({ kind: "offline_stock_case.resolve" });

    // A's -5 kept B's unit on central, so it took none of B's units off: never a link candidate.
    const correction = await prisma.stockLedger.findFirstOrThrow({ where: { tenantId: c.fx.tenantId, referenceId: planA.id, qtyDelta: { lt: 0 } } });
    const detailB = await cases.detail(c.fx.tenantId, branch(c), caseB);
    expect(detailB.batches[0]!.movementCandidates.map((m) => m.ledgerEntryId)).not.toContain(correction.id);
    await cases.cancel(c.manager, branch(c), planB.id);
    await expect(cases.prepare(c.manager, branch(c), caseB, {
      kind: "link_existing_settlement", links: [{ batchId: c.batches.partition, source: "movements", ledgerEntryIds: [correction.id] }],
    })).rejects.toMatchObject({ response: { code: "SETTLEMENT_NOT_LINKABLE" } });

    // B is counted (still 2 on the shelf): 2 + 1 = 3, no correction, B posts 1. Central = the shelf.
    const againB = await cases.prepare(c.manager, branch(c), caseB, { kind: "count_and_correct" });
    await run(c, c.manager, await signedResolve(c, c.manager, againB.id,
      [{ batchId: c.batches.partition, countedQty: 2 }], againB.executionApprovalId));
    expect(await onHand(c.batches.partition)).toBe(2);
    expect(await reviewSet(c)).toEqual([]);
  });

  it("a count covers held units: those it leaves no room for come off quarantine, and the sale still posts", async () => {
    const c = await counter({ partition: 10 });
    await prisma.$transaction((t) => stock.quarantine(t,
      { tenantId: c.fx.tenantId, branchId: branch(c), userId: c.fx.ownerId, referenceId: randomUUID() },
      { productId: c.fx.productId, batchId: c.batches.partition, qty: 4, reasonCode: "damaged" }));
    // 6 sellable and 4 held; 8 sold offline (the snapshot still allowed 10): short.
    const { ack } = await offlineSale(c, [[c.batches.partition, 8]]);
    const plan = await cases.prepare(c.manager, branch(c), ack.reconciliationCaseId!, { kind: "count_and_correct" });

    // Nothing is left, held units included. The held 4 come off quarantine, sellable gains 2 so
    // the sale's 8 post from it, and the batch ends empty: -2 overall, as the count says.
    const done = await run(c, c.manager, await signedResolve(c, c.manager, plan.id,
      [{ batchId: c.batches.partition, countedQty: 0 }], plan.executionApprovalId));
    expect(done.result).toMatchObject({ batches: [{ method: "counted", correctionQty: -2, postedQty: 8 }] });
    expect(await batchStock(c.batches.partition)).toMatchObject({ onHandQty: 0, quarantinedQty: 0 });
    const corrections = await prisma.stockLedger.findMany({ where: { tenantId: c.fx.tenantId, referenceId: plan.id }, orderBy: { qtyDelta: "asc" } });
    expect(corrections.map((l) => [l.movementType, l.bucket, l.qtyDelta])).toEqual([
      ["adjustment_out", "quarantine", -4], ["adjustment_in", "sellable", 2],
    ]);
  });

  it("refuses an executor without inventory authority, wrong counts, and editing a plan in place", async () => {
    const c = await counter({ main: 4 });
    await onlineSale(c, c.batches.main, 3);
    const { ack } = await offlineSale(c, [[c.batches.main, 2]]);
    const plan = await cases.prepare(c.manager, branch(c), ack.reconciliationCaseId!, { kind: "count_and_correct" });
    // A cashier has no inventory.manage: the counter refuses before anything moves.
    await expect(signedResolve(c, c.cashier, plan.id, [{ batchId: c.batches.main, countedQty: 0 }], plan.executionApprovalId))
      .rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
    await expect(run(c, c.manager, await signedResolve(c, c.manager, plan.id, [], plan.executionApprovalId)))
      .rejects.toThrow("Count every batch");
    await expect(prisma.offlineStockResolution.update({ where: { id: plan.id }, data: { kind: "post_now" } }))
      .rejects.toThrow("immutable");
    expect(await onHand(c.batches.main)).toBe(1);
    // A cashier cannot review or plan either.
    await expect(cases.prepare(c.cashier, branch(c), ack.reconciliationCaseId!, { kind: "post_now" })).rejects.toThrow();
  });
});
