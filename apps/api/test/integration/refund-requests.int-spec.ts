import { randomUUID } from "node:crypto";
import { PaymentMethod, Prisma, PrismaClient, StockMovementType } from "@prisma/client";
import type {
  OnlineTerminalCommand,
  SignedPhysicalOperation,
  TerminalEnrollmentCommand,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService, type AuditInput } from "../../src/audit/audit.service";
import { DailyWorkService } from "../../src/dashboard/daily-work.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { RefundRequestsService } from "../../src/sales/refund-requests.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../src/security/operation-authorization.service";
import { SignedOperations } from "../../src/terminal-commands/signed-operations";
import { TerminalCommandExecutor } from "../../src/terminal-commands/terminal-command.executor";
import {
  LocalAttendanceVerifier,
  type AttendanceExpectation,
} from "../../src/terminals/local-attendance.verifier";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import { TillShiftsService } from "../../src/terminals/shifts/till-shifts.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { batchTotals, createPrisma, createStockedBatch, createTenant, openTestShift, type TenantFixture } from "./fixtures";

const prisma: PrismaClient = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);

/** Test-only: fail one named audit event, to prove audit failures roll back everything. */
class InjectableAudit extends AuditService {
  failOn: string | null = null;
  override async log(input: AuditInput, client?: Prisma.TransactionClient) {
    if (input.eventName === this.failOn) throw new Error(`Injected ${input.eventName} audit failure`);
    return super.log(input, client);
  }
}
/** Test-only independent attendance authority, as in terminal-execution.int-spec.ts. */
class FixtureAttendance extends LocalAttendanceVerifier {
  readonly proofs = new Map<string, AttendanceExpectation>();
  allow(
    p: TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>,
    purpose: AttendanceExpectation["purpose"],
  ) {
    const id = randomUUID();
    this.proofs.set(id, {
      purpose,
      identity: p.identity,
      actorUserId: "requestedByUserId" in p ? p.requestedByUserId : p.session.staffUserId,
      registerId: "registerId" in p ? p.registerId : p.session.registerId,
      tillId: "tillId" in p ? p.tillId : p.session.tillId,
      payloadDigest: sha256(boundedCanonical(p)),
    });
    return id;
  }
  override async verify(_tx: Prisma.TransactionClient, proofId: string, expected: AttendanceExpectation) {
    if (boundedCanonical(this.proofs.get(proofId) ?? {}) !== boundedCanonical(expected))
      throw new Error("Unverified attendance");
    return proofId;
  }
}
class OpenHours extends MandatoryOperationEvidence {
  override async hours() {}
}

const audit = new InjectableAudit(proxy as never);
const stock = new StockService();
const access = new AccessService(proxy as never, {} as never);
const approvals = new ManagementApprovalsService(access, audit);
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const authorization = new OperationAuthorizationService(access, trust, new OpenHours(), approvals);
// P2b #103: a refund executed at the counter comes out of the executor's open till shift.
const shifts = new TillShiftsService(proxy as never, trust, new OperatingHoursEvidence(), access, audit, {} as never);
const sales = new SalesService(proxy as never, audit, {} as never, {} as never, {} as never, stock,
  undefined, undefined, undefined, undefined, shifts);
const refunds = new RefundRequestsService(proxy as never, audit, access, approvals, sales, stock);
const executor = new TerminalCommandExecutor(proxy as never, trust, authorization,
  new SignedOperations({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, refunds, {} as never, {} as never),
  audit, access);
const EXECUTE = "POST /api/v1/sales/refund-requests/:id/execute" satisfies SignedPhysicalOperation;

let fx: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (userId: string): RequestUser => ({
  userId, tenantId: fx.tenantId, tokenVersion: 0, branchRoles: [], email: "refund@it.test",
  fullName: "Refund actor", authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });

async function counterFor(who: string) {
  const owner = user(fx.ownerId);
  const device = terminalDevice();
  const counter = await tx(c => trust.createCounter(c, owner, branch(), `Counter ${randomUUID().slice(0, 6)}`));
  const enrollment = await tx(c => trust.beginEnrollment(c, owner, branch(), {
    registerId: counter.id, label: "Desk", keyId: randomUUID(), publicKeyHex: device.publicKeyHex,
  }));
  const identity = await tx(c => trust.finishEnrollment(c, owner, branch(),
    device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment, "enrollment")));
  const staff = user(who);
  const sessionPayload = await tx(c => trust.beginSession(c, staff, branch(), identity));
  const session = await tx(c => trust.finishSession(c, staff, branch(),
    device.sign(sessionPayload, identity.keyId), attendance.allow(sessionPayload, "session")));
  const shiftId = await openTestShift(prisma, fx.tenantId, session.workSessionId);
  return { device, identity, session, staff, shiftId };
}
type Counter = Awaited<ReturnType<typeof counterFor>>;
async function signed(counter: Counter, body: unknown, approvalEvidenceId: string | null) {
  const payload = await executor.prepare(counter.staff, branch(), {
    workSessionId: counter.session.workSessionId, operation: EXECUTE, body, approvalEvidenceId,
    pharmacistEvidenceId: null, operatingHoursExceptionId: null,
  }) as OnlineTerminalCommand<unknown>;
  return { payload, request: {
    command: counter.device.sign(payload, counter.identity.keyId),
    attendanceProofId: attendance.allow(payload, "command"),
  } };
}
const run = (counter: Counter, request: unknown) => executor.execute(counter.staff, branch(), request);

async function setThreshold(value: string | null) {
  await prisma.tenantSettings.upsert({
    where: { tenantId: fx.tenantId },
    create: { tenantId: fx.tenantId, approvalRequiredReturnThreshold: value },
    update: { approvalRequiredReturnThreshold: value },
  });
}

/** A posted cash sale of `qty` units at 100.00 each, stock issued through StockService. */
async function cashSale(qty = 4) {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
  const total = new Prisma.Decimal(100).mul(qty);
  const sale = await prisma.sale.create({ data: {
    tenantId: fx.tenantId, branchId: branch(), invoiceNo: `INV-${randomUUID().slice(0, 8)}`,
    subtotal: total, grandTotal: total, amountPaid: total, soldBy: fx.clerkId,
    items: { create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty, unitPrice: "100.00", lineTotal: total } },
    payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: total } },
  } });
  await tx(c => stock.issue(c, { tenantId: fx.tenantId, branchId: branch(), userId: fx.clerkId,
    referenceType: "sale", referenceId: sale.id },
  [{ productId: fx.productId, batchId, qty, movementType: StockMovementType.sale_out, from: "sellable" as const }]));
  return { saleId: sale.id, batchId };
}
const cashOut = async (saleId: string) =>
  (await prisma.salePayment.aggregate({ where: { tenantId: fx.tenantId, saleId, amount: { lt: 0 } }, _sum: { amount: true } }))._sum.amount?.toFixed(2) ?? "0.00";
const refundAudits = (saleId: string) =>
  prisma.auditEvent.count({ where: { tenantId: fx.tenantId, eventName: "sale.refunded", entityId: saleId } });

beforeAll(async () => {
  fx = await createTenant(prisma, "refund-requests");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
    // The counter cashier: terminal.execute and sales.refund are cashier defaults.
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "cashier" },
  ] });
});
afterAll(() => prisma.$disconnect());
afterEach(async () => {
  audit.failOn = null;
  await setThreshold(null);
});

const lines = (batchId: string, qty: number) => [{ productId: fx.productId, batchId, qty }];

describe("remote preparation and approval move no stock or money", () => {
  it("prepares within the original-sale limit and refuses beyond it", async () => {
    const { saleId, batchId } = await cashSale(4);
    await expect(refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 5) }))
      .rejects.toMatchObject({ status: 400 });
    const before = await batchTotals(prisma, batchId);
    const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 2) });
    expect(request).toMatchObject({ status: "prepared", amount: "200.00", approvalRequired: false, readyAtCounter: true });
    expect(await batchTotals(prisma, batchId)).toEqual(before);
    expect(await cashOut(saleId)).toBe("0.00");
    // One open request per sale.
    await expect(refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 1) }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("over the threshold waits for exact approval; the requester cannot approve their own", async () => {
    await setThreshold("150.00");
    await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner"] } });
    try {
      const { saleId, batchId } = await cashSale(4);
      const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "wrong_item", items: lines(batchId, 2) });
      expect(request).toMatchObject({ status: "prepared", approvalRequired: true, readyAtCounter: false, executionApprovalId: null });
      const review = request.approvalReview!;
      // An approver's queue (request claims are not under test here).
      const work = new DailyWorkService(proxy as never, { resolve: async () => ({ canSelfApprove: false, has: () => true }) } as never);
      const kindOf = async () => (await work.get(user(fx.ownerId), branch(), { filter: "all", category: "counter", page: 1 }, { pageSize: 200 }))
        .items.find((item) => item.reference === request.requestNumber)?.kind;
      expect(await kindOf()).toBe("sale_refund.approve");
      await expect(refunds.approve(user(fx.managerId), branch(), request.id, { approvalId: randomUUID(), ...review }))
        .rejects.toMatchObject({ status: 403 });
      await expect(refunds.approve(user(fx.ownerId), branch(), request.id,
        { approvalId: randomUUID(), expectedVersion: review.expectedVersion, expectedDigest: "0".repeat(64) }))
        .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
      const approved = await refunds.approve(user(fx.ownerId), branch(), request.id, { approvalId: randomUUID(), ...review });
      expect(approved).toMatchObject({ status: "approved", readyAtCounter: true, approver: { id: fx.ownerId },
        requester: { id: fx.managerId }, executor: null });
      expect(await kindOf()).toBe("sale_refund.execute");
      expect((await batchTotals(prisma, batchId)).onHand).toBe(16);
      expect(await cashOut(saleId)).toBe("0.00");
    } finally {
      await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner", "manager"] } });
    }
  });
});

// Exercise the common Daily work projection with real live branch permissions.
const moduleWork = new DailyWorkService(proxy as never, {
  resolve: (actor: RequestUser, activeBranch: string) => access.resolveLive(actor, activeBranch, prisma),
} as never);
const approvalQueue = (actor: RequestUser, activeBranch: string, query: { page?: number; pageSize?: number; q?: string }) =>
  moduleWork.get(actor, activeBranch, { filter: "all", kind: "sale_refund.approve", page: 1, ...query });

describe("W4 pending approvals through shared Daily work", () => {
  it("discovers decisions across modules and narrows module views from the same snapshot", async () => {
    const prefix = `WORK-${randomUUID().slice(0, 8)}`;
    const sale = await cashSale();
    await prisma.sale.update({ where: { id: sale.saleId }, data: { invoiceNo: `${prefix}-SALE` } });
    const request = await refunds.prepare(user(fx.managerId), branch(), sale.saleId, { reasonCode: "damaged", items: lines(sale.batchId, 1) });
    await setThreshold("50");
    await prisma.stocktake.create({ data: { tenantId: fx.tenantId, branchId: branch(), stocktakeNumber: `${prefix}-COUNT`, title: prefix, status: "submitted", countedBy: fx.clerkId } });
    await prisma.transfer.create({ data: { tenantId: fx.tenantId, fromBranchId: branch(), toBranchId: fx.otherBranchId, transferNumber: `${prefix}-TRANSFER`, requestedBy: fx.clerkId } });
    const all = await moduleWork.get(user(fx.ownerId), branch(), { filter: "approvals", q: prefix, page: 1, pageSize: 25 });
    expect(all.items.map(row => row.kind).sort()).toEqual(["sale_refund.approve", "stocktake.approve", "transfer.approve"]);
    expect(all.total).toBe(3);
    expect(all.counts.approvals).toBe(3);
    const pending = await approvalQueue(user(fx.ownerId), branch(), { q: prefix });
    expect(pending.total).toBe(1);
    expect(pending.counts.approvals).toBe(1);
    expect(pending.categories).toEqual({ counter: 1 });
    expect(pending.items[0]!.href).toBe(`/sales?view=pending-approvals&request=${request.id}`);
    const stocktakes = await moduleWork.get(user(fx.ownerId), branch(), { filter: "approvals", kind: "stocktake.approve", q: prefix, page: 1 });
    expect(stocktakes.items.map(row => row.kind)).toEqual(["stocktake.approve"]);
    expect((await moduleWork.get(user(fx.clerkId), branch(), { filter: "approvals", q: prefix, page: 1 })).items).toEqual([]);
  });

  it("paginates all waiting requests oldest first, then removes approved/cancelled ones without physical effects", async () => {
    await setThreshold("100");
    await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner"] } });
    try {
      const created = [];
      const prefix = `QUEUE-${randomUUID().slice(0, 8)}`;
      for (let index = 0; index < 3; index++) {
        const sale = await cashSale(2);
        await prisma.sale.update({ where: { id: sale.saleId }, data: { invoiceNo: `${prefix}-${index}` } });
        const before = await batchTotals(prisma, sale.batchId);
        const request = await refunds.prepare(user(fx.managerId), branch(), sale.saleId, { reasonCode: "damaged", items: lines(sale.batchId, 1) });
        created.push({ request, sale, before });
      }
      const first = await approvalQueue(user(fx.managerId), branch(), { page: 1, pageSize: 2, q: prefix });
      const second = await approvalQueue(user(fx.ownerId), branch(), { page: 2, pageSize: 2, q: prefix });
      expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(first.items.map(row => row.id)).toEqual(created.slice(0, 2).map(row => `refund:${row.request.id}`));
      expect(first.items.every(row => row.blocked)).toBe(true);
      expect(second.items.map(row => row.id)).toEqual([`refund:${created[2]!.request.id}`]);
      expect(second.items[0]!.blocked).toBe(false);
      expect((await refunds.getOne(fx.tenantId, branch(), created[0]!.request.id)).lines[0]).toMatchObject({ qty: 1, disposition: "restock", productName: expect.any(String), batchNo: expect.any(String) });
      const one = created[0]!;
      await refunds.approve(user(fx.ownerId), branch(), one.request.id, { approvalId: randomUUID(), ...one.request.approvalReview! });
      await refunds.cancel(user(fx.managerId), branch(), created[1]!.request.id);
      const remaining = await approvalQueue(user(fx.ownerId), branch(), { q: prefix });
      expect(remaining.total).toBe(1);
      expect(remaining.items[0]!.id).toBe(`refund:${created[2]!.request.id}`);
      for (const item of created) {
        expect(await cashOut(item.sale.saleId)).toBe("0.00");
        expect(await batchTotals(prisma, item.sale.batchId)).toEqual(item.before);
      }
    } finally {
      await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner", "manager"] } });
    }
  });

  it("includes lowered-threshold and revoked approvals, shares daily-work routing, and treats search characters literally", async () => {
    const sale = await cashSale(3);
    const invoiceNo = `QUEUE%_${randomUUID().slice(0, 8)}`;
    await prisma.sale.update({ where: { id: sale.saleId }, data: { invoiceNo } });
    const request = await refunds.prepare(user(fx.managerId), branch(), sale.saleId, { reasonCode: "damaged", items: lines(sale.batchId, 2) });
    expect((await approvalQueue(user(fx.ownerId), branch(), { q: invoiceNo })).total).toBe(0);
    await setThreshold("100");
    expect((await approvalQueue(user(fx.ownerId), branch(), { q: invoiceNo })).items.map(row => row.id)).toEqual([`refund:${request.id}`]);
    const approved = await refunds.approve(user(fx.ownerId), branch(), request.id, { approvalId: randomUUID(), ...request.approvalReview! });
    expect((await approvalQueue(user(fx.ownerId), branch(), { q: invoiceNo })).total).toBe(0);
    await tx(c => approvals.revoke(c, user(fx.ownerId), branch(), approved.executionApprovalId!, "Needs another review"));
    // An issued approval remains pinned even if the threshold is subsequently switched off.
    await setThreshold(null);
    const inbox = await approvalQueue(user(fx.ownerId), branch(), { q: invoiceNo.toLowerCase() });
    expect(inbox.items[0]).toMatchObject({ id: `refund:${request.id}`, approval: true });
    expect(await refunds.getOne(fx.tenantId, branch(), request.id)).toMatchObject({ approvalRevoked: true, readyAtCounter: false });
    const work = new DailyWorkService(proxy as never, { resolve: async () => ({ canSelfApprove: true, has: (key: string) => key === "returns.approve" }) } as never);
    const item = (await work.get(user(fx.ownerId), branch(), { filter: "all", category: "counter", page: 1 }, { pageSize: 200 }))
      .items.find(row => row.reference === request.requestNumber);
    expect(item).toMatchObject({ kind: "sale_refund.approve", href: `/sales?view=pending-approvals&request=${request.id}`, where: "web" });
    expect((await approvalQueue(user(fx.ownerId), branch(), { q: "QUEUE%_does-not-exist" })).total).toBe(0);
  });

  it("rejects non-approvers, stale authentication and unassigned branches; detail never crosses tenant or branch", async () => {
    expect((await approvalQueue(user(fx.clerkId), branch(), {})).items).toEqual([]);
    await expect(approvalQueue({ ...user(fx.ownerId), tokenVersion: 999 }, branch(), {})).rejects.toMatchObject({ status: 403 });
    await expect(approvalQueue(user(fx.managerId), fx.otherBranchId, {})).rejects.toMatchObject({ status: 403 });
    const sale = await cashSale();
    const request = await refunds.prepare(user(fx.managerId), branch(), sale.saleId, { reasonCode: "damaged", items: lines(sale.batchId, 1) });
    await expect(refunds.getOne(fx.tenantId, fx.otherBranchId, request.id)).rejects.toMatchObject({ status: 404 });
    await expect(refunds.getOne(randomUUID(), branch(), request.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("execution at the counter", () => {
  let counter: Counter;
  beforeAll(async () => {
    counter = await counterFor(fx.clerkId);
  });

  it("refunds once through a signed command: stock back, cash out, replayable receipt", async () => {
    const { saleId, batchId } = await cashSale(4);
    const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 3) });
    const command = await signed(counter, { refundRequestId: request.id }, null);
    const first = await run(counter, command.request);
    const replay = await run(counter, command.request);
    expect(first.result).toMatchObject({ type: "sale_refund.executed", refundRequestId: request.id, approvalId: null,
      amountMinor: 30000, refundedTo: [{ method: "cash", amountMinor: 30000 }], effect: "applied" });
    expect({ ...replay, replayed: false }).toEqual(first);
    expect(await cashOut(saleId)).toBe("-300.00");
    expect((await batchTotals(prisma, batchId)).onHand).toBe(19);
    expect(await refundAudits(saleId)).toBe(1);
    const refunded = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId, eventName: "sale.refunded", entityId: saleId } });
    expect(refunded.payload).toMatchObject({ refundRequestId: request.id, requestedByUserId: fx.managerId,
      executedByUserId: fx.clerkId, approvedByUserId: null, approvalWaived: true,
      command: { commandId: command.payload.commandId } });
    // Under the threshold nobody approved it, so the goods return names no approver.
    const goodsReturn = await prisma.goodsReturn.findFirstOrThrow({ where: { id: (first.result as { goodsReturnId: string }).goodsReturnId } });
    expect(goodsReturn).toMatchObject({ requestedBy: fx.managerId, approvedBy: null, processedBy: fx.clerkId });
    // The cash came out of the executor's open shift on that till.
    expect(goodsReturn.shiftId).toBe(counter.shiftId);
    const paidOut = await prisma.salePayment.findFirstOrThrow({ where: { tenantId: fx.tenantId, saleId, amount: { lt: 0 } } });
    expect(paidOut.shiftId).toBe(counter.shiftId);
    // A distinct second command finds it executed: no second refund.
    const again = await signed(counter, { refundRequestId: request.id }, null);
    expect((await run(counter, again.request)).result).toMatchObject({ effect: "already_applied", refundedTo: [] });
    expect(await cashOut(saleId)).toBe("-300.00");
  });

  it("concurrent retries and browser executions refund once", async () => {
    const { saleId, batchId } = await cashSale(4);
    const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 4) });
    const command = await signed(counter, { refundRequestId: request.id }, null);
    const settled = await Promise.allSettled([
      run(counter, command.request), run(counter, command.request),
      refunds.execute(user(fx.managerId), branch(), request.id, { approvalId: null }),
      refunds.execute(user(fx.managerId), branch(), request.id, { approvalId: null }, "key-1"),
    ]);
    expect(settled.every(s => s.status === "fulfilled")).toBe(true);
    expect(await cashOut(saleId)).toBe("-400.00");
    expect(await refundAudits(saleId)).toBe(1);
    expect((await prisma.sale.findFirstOrThrow({ where: { id: saleId } })).status).toBe("refunded");
  });

  it("over the threshold, executes only with the pinned exact approval", async () => {
    await setThreshold("150.00");
    const { saleId, batchId } = await cashSale(4);
    // A manager may approve their own requests by default: the evidence is recorded at preparation.
    const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 2) });
    expect(request).toMatchObject({ status: "approved", readyAtCounter: true });
    const missing = await signed(counter, { refundRequestId: request.id }, null);
    await expect(run(counter, missing.request)).rejects.toMatchObject({ response: { code: "APPROVAL_REQUIRED" } });
    await expect(refunds.execute(user(fx.clerkId), branch(), request.id, { approvalId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const pinned = await signed(counter, { refundRequestId: request.id }, request.executionApprovalId);
    const done = await run(counter, pinned.request);
    expect(done.result).toMatchObject({ approvalId: request.executionApprovalId, effect: "applied" });
    expect(await prisma.goodsReturn.findFirstOrThrow({ where: { id: (done.result as { goodsReturnId: string }).goodsReturnId } }))
      .toMatchObject({ approvedBy: fx.managerId, processedBy: fx.clerkId });
    expect(await cashOut(saleId)).toBe("-200.00");
  });

  it("refuses a revoked approval and a refund that exceeds what is now returnable", async () => {
    await setThreshold("150.00");
    const revokedSale = await cashSale(4);
    const revoked = await refunds.prepare(user(fx.managerId), branch(), revokedSale.saleId, { reasonCode: "damaged", items: lines(revokedSale.batchId, 2) });
    await tx(c => approvals.revoke(c, user(fx.ownerId), branch(), revoked.executionApprovalId!, "Wrong customer"));
    const command = await signed(counter, { refundRequestId: revoked.id }, revoked.executionApprovalId);
    await expect(run(counter, command.request)).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });
    expect(await cashOut(revokedSale.saleId)).toBe("0.00");

    await setThreshold(null);
    const raced = await cashSale(4);
    const prepared = await refunds.prepare(user(fx.managerId), branch(), raced.saleId, { reasonCode: "damaged", items: lines(raced.batchId, 3) });
    // Meanwhile the till refunded two units the old way.
    await sales.refundSale(fx.tenantId, branch(), fx.ownerId, await tx(c => access.resolveLive(user(fx.ownerId), branch(), c)),
      raced.saleId, { reasonCode: "damaged", items: lines(raced.batchId, 2) });
    await expect(refunds.execute(user(fx.clerkId), branch(), prepared.id, { approvalId: null })).rejects.toMatchObject({ status: 400 });
    expect(await cashOut(raced.saleId)).toBe("-200.00");
  });

  it("a threshold lowered after preparation requires approval before execution", async () => {
    const { saleId, batchId } = await cashSale(4);
    const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 3) });
    await setThreshold("100.00");
    await expect(refunds.execute(user(fx.clerkId), branch(), request.id, { approvalId: null }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_REQUIRED" } });
    expect(await cashOut(saleId)).toBe("0.00");
  });

  it("prepared content cannot be edited in place", async () => {
    const { saleId, batchId } = await cashSale(2);
    const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 1) });
    await expect(prisma.$executeRaw`UPDATE sale_refund_request SET amount = 999 WHERE id = ${request.id}::uuid`)
      .rejects.toThrow(/immutable/);
  });

  it("an injected audit failure rolls back stock, money, request and receipt; the retry refunds once", async () => {
    const { saleId, batchId } = await cashSale(4);
    const request = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 2) });
    const command = await signed(counter, { refundRequestId: request.id }, null);
    audit.failOn = "sale.refunded";
    await expect(run(counter, command.request)).rejects.toThrow("Injected sale.refunded audit failure");
    expect(await cashOut(saleId)).toBe("0.00");
    expect((await batchTotals(prisma, batchId)).onHand).toBe(16);
    expect((await refunds.getOne(fx.tenantId, branch(), request.id)).status).toBe("prepared");
    expect(await prisma.terminalCommandReceipt.count({ where: { tenantId: fx.tenantId, commandId: command.payload.commandId } })).toBe(0);
    audit.failOn = null;
    expect((await run(counter, command.request)).result).toMatchObject({ effect: "applied" });
    expect(await cashOut(saleId)).toBe("-200.00");
    expect(await refundAudits(saleId)).toBe(1);
  });

  it("the legacy till refund and a prepared refund serialize on the sale and never over-refund", async () => {
    const { saleId, batchId } = await cashSale(3);
    const prepared = await refunds.prepare(user(fx.managerId), branch(), saleId, { reasonCode: "damaged", items: lines(batchId, 3) });
    const owner = await tx(c => access.resolveLive(user(fx.ownerId), branch(), c));
    const settled = await Promise.allSettled([
      refunds.execute(user(fx.clerkId), branch(), prepared.id, { approvalId: null }),
      sales.refundSale(fx.tenantId, branch(), fx.ownerId, owner, saleId, { reasonCode: "damaged", items: lines(batchId, 3) }),
    ]);
    expect(settled.filter(s => s.status === "fulfilled")).toHaveLength(1);
    expect(await cashOut(saleId)).toBe("-300.00");
  });
});
