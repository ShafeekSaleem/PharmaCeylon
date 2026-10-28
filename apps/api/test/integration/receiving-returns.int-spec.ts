import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  OnlineTerminalCommand,
  SignedPhysicalOperation,
  TerminalEnrollmentCommand,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService, type AuditInput } from "../../src/audit/audit.service";
import { businessDateKey } from "../../src/common/business-date.util";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { PreparedReceiptService } from "../../src/purchasing/prepared-receipt.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { ReturnsService } from "../../src/returns/returns.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../src/security/operation-authorization.service";
import { SignedOperations } from "../../src/terminal-commands/signed-operations";
import { TerminalCommandExecutor } from "../../src/terminal-commands/terminal-command.executor";
import { LocalAttendanceVerifier, type AttendanceExpectation } from "../../src/terminals/local-attendance.verifier";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { actor, batchTotals, createPrisma, createStockedBatch, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

/**
 * P6 split of direct receiving (prepared receipts) and supplier returns: remote approval records
 * exact evidence with no stock or ledger effect; the counter's post is pinned to that approval,
 * rechecked after lock waits, and runs through StockService — from the browser route and as a
 * signed terminal command with an original-result receipt.
 */
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
  allow(p: TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>,
    purpose: AttendanceExpectation["purpose"]) {
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
const notifications = { notifyByPermission: jest.fn().mockResolvedValue(1), notifyUser: jest.fn().mockResolvedValue(undefined) };
const purchasing = new PurchasingService(proxy as never, audit, stock, new StockReadService(proxy as never));
const prepared = new PreparedReceiptService(proxy as never, purchasing, notifications as never, audit, access, approvals);
const returns = new ReturnsService(proxy as never, audit, stock, access, approvals);
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const authorization = new OperationAuthorizationService(access, trust, new OpenHours(), approvals);
const executor = new TerminalCommandExecutor(proxy as never, trust, authorization,
  new SignedOperations({} as never, {} as never, {} as never, {} as never, {} as never, prepared, returns), audit, access);

let fx: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (userId: string): RequestUser => ({ tenantId: fx.tenantId, userId, tokenVersion: 0, branchRoles: [],
  email: "p6@it.test", fullName: "P6 actor", authMethod: "bearer" });
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
const today = () => daysFromToday(0).toISOString().slice(0, 10);
const audits = (eventName: string, entityId: string) =>
  prisma.auditEvent.count({ where: { tenantId: fx.tenantId, eventName, entityId } });
const setRole = (userId: string, role: "manager" | "cashier" | "owner") =>
  prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, branchId: branch(), userId }, data: { role } });

beforeAll(async () => {
  fx = await createTenant(prisma, "p6-receiving-returns");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.clerkId, role: "inventory_clerk" },
  ] });
});
afterAll(() => prisma.$disconnect());
afterEach(async () => {
  audit.failOn = null;
  jest.restoreAllMocks();
});

/** Holds real batch locks until released, and reports the backend that holds them. */
async function holdBatchLocks(batchIds: string[]) {
  let release!: () => void;
  let ready!: (pid: number) => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<number>((resolve) => { ready = resolve; });
  const blocker = prisma.$transaction(async (t) => {
    await stock.lockBatches(t, fx.tenantId, batchIds);
    const rows = await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    ready(rows[0]!.pid);
    await gate;
  }, { timeout: 15_000 });
  const pid = await acquired;
  const waitedOn = async () => {
    for (let i = 0; i < 80; i++) {
      const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY(pg_blocking_pids(pid))) AS waiting`;
      if (rows[0]!.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  return { release, blocker, waitedOn };
}

// ── prepared receipts ───────────────────────────────────────────────────────────────

async function issuedOrder(orderedQty = 10) {
  return prisma.purchaseOrder.create({ data: {
    tenantId: fx.tenantId, branchId: branch(), supplierId: fx.supplierId, createdBy: fx.managerId,
    poNumber: `PO-${randomUUID().slice(0, 8)}`, status: "issued", items: { create: { tenantId: fx.tenantId,
      productId: fx.productId, orderedQty, unitCost: "10.00", taxPercent: 0 } },
  } });
}
function deliveryLine(receivedQty: number, batchNo = `PR-${randomUUID().slice(0, 8)}`) {
  return { productId: fx.productId, batchNo, expiryDate: daysFromToday(400).toISOString().slice(0, 10),
    receivedQty, sellingPrice: "15.00" };
}
async function preparedDelivery(opts: { qty?: number; ordered?: number; batchNo?: string; acceptOverDelivery?: boolean;
  preparer?: string } = {}) {
  const po = await issuedOrder(opts.ordered ?? 10);
  const row = await prepared.create(user(opts.preparer ?? fx.clerkId), branch(), po.id, {
    delivery: { supplierDeliveryNote: "DN-1", acceptOverDelivery: opts.acceptOverDelivery,
      lines: [deliveryLine(opts.qty ?? 10, opts.batchNo)] },
  });
  return { poId: po.id, id: row.id, review: row.approvalReview! };
}
const approvePrepared = async (id: string, who = fx.managerId) => {
  const [row] = await prepared.list(fx.tenantId, branch(), { canViewCost: true, status: undefined })
    .then((rows) => rows.filter((r) => r.id === id));
  return prepared.approve(user(who), branch(), id, { approvalId: randomUUID(), ...row!.approvalReview! });
};
const receiptsOn = (poId: string) => prisma.goodsReceipt.count({ where: { tenantId: fx.tenantId, purchaseOrderId: poId } });
const placeholderInvoices = (poId: string) => prisma.supplierInvoice.count({ where: {
  tenantId: fx.tenantId, source: "system", receipts: { some: { goodsReceipt: { purchaseOrderId: poId } } } } });

describe("prepared receipts: remote approval, counter posting", () => {
  it("approves without stock, receipt or invoice, then posts exactly once with three actors recorded", async () => {
    const d = await preparedDelivery();
    const approved = await approvePrepared(d.id);
    expect(approved.status).toBe("approved");
    expect(await receiptsOn(d.poId)).toBe(0);
    expect(await placeholderInvoices(d.poId)).toBe(0);
    expect(await prisma.batch.count({ where: { tenantId: fx.tenantId, batchNo: approved.delivery.lines[0]!.batchNo } })).toBe(0);

    const posts = await Promise.all([
      prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: approved.executionApprovalId! }),
      prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: approved.executionApprovalId! }),
    ]);
    expect(new Set(posts.map((p) => p.goodsReceiptId)).size).toBe(1);
    expect(await receiptsOn(d.poId)).toBe(1);
    expect(await placeholderInvoices(d.poId)).toBe(1);
    const receipt = await prisma.goodsReceipt.findFirstOrThrow({ where: { tenantId: fx.tenantId, purchaseOrderId: d.poId },
      include: { items: true } });
    // Received on the posting day at the branch: the tenant's business date, not UTC.
    expect(receipt.receivedOn.toISOString().slice(0, 10)).toBe(businessDateKey("Asia/Colombo"));
    expect((await batchTotals(prisma, receipt.items[0]!.batchId)).onHand).toBe(10);
    expect((await prisma.purchaseOrder.findFirstOrThrow({ where: { id: d.poId } })).status).toBe("received");
    const posted = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId,
      eventName: "purchase_order.prepared_receipt_posted", entityId: d.id } });
    expect(posted.payload).toMatchObject({ requestedByUserId: fx.clerkId, approvedByUserId: fx.managerId,
      executedByUserId: fx.clerkId, approvalId: approved.executionApprovalId, goodsReceiptId: receipt.id });
    expect(await audits("purchase_order.prepared_receipt_posted", d.id)).toBe(1);
  });

  it("a material edit clears the approval and a stale confirmation or preview is refused", async () => {
    const d = await preparedDelivery();
    const first = await approvePrepared(d.id);
    const edited = await prepared.update(user(fx.clerkId), branch(), d.id, {
      expectedVersion: first.approvalVersion, delivery: { lines: [deliveryLine(8, first.delivery.lines[0]!.batchNo)] },
    });
    expect(edited.status).toBe("draft");
    expect(edited.executionApprovalId).toBeNull();
    await expect(prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: first.executionApprovalId! }))
      .rejects.toThrow(/Approval changed/);
    await expect(prepared.approve(user(fx.managerId), branch(), d.id, { approvalId: randomUUID(), ...d.review }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    // A note is not material: the approval survives it.
    const second = await approvePrepared(d.id);
    const noted = await prepared.update(user(fx.clerkId), branch(), d.id, { expectedVersion: second.approvalVersion, notes: "Driver arrives at 3" });
    expect(noted.executionApprovalId).toBe(second.executionApprovalId);
    await prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: second.executionApprovalId! });
    expect(await receiptsOn(d.poId)).toBe(1);
  });

  it("refuses other receiving while approved, and an order received in between makes the approval stale", async () => {
    const d = await preparedDelivery();
    const approved = await approvePrepared(d.id);
    await expect(purchasing.receiveGoods(fx.tenantId, branch(), fx.clerkId, actor(fx.clerkId, ["purchasing.receive"]),
      { purchaseOrderId: d.poId, receivedOn: today(), lines: [deliveryLine(2)] }))
      .rejects.toMatchObject({ response: { code: "RECEIPT_PREPARED" } });
    // A legacy/internal writer moves the order's received counters: the approved basis changed.
    await prisma.purchaseOrderItem.updateMany({ where: { tenantId: fx.tenantId, purchaseOrderId: d.poId }, data: { receivedQty: 3 } });
    await expect(prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: approved.executionApprovalId! }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    expect(await receiptsOn(d.poId)).toBe(0);
  });

  it("carries the approver's over-delivery decision to a receiver who cannot approve", async () => {
    const withFlag = await preparedDelivery({ qty: 14, ordered: 10, acceptOverDelivery: true });
    const ok = await approvePrepared(withFlag.id);
    await prepared.post(user(fx.clerkId), branch(), withFlag.id, { approvalId: ok.executionApprovalId! });
    expect(await receiptsOn(withFlag.poId)).toBe(1);

    const withoutFlag = await preparedDelivery({ qty: 14, ordered: 10 });
    const refused = await approvePrepared(withoutFlag.id);
    await expect(prepared.post(user(fx.clerkId), branch(), withoutFlag.id, { approvalId: refused.executionApprovalId! }))
      .rejects.toMatchObject({ response: { code: "OVER_DELIVERY" } });
    expect((await prisma.preparedReceipt.findFirstOrThrow({ where: { id: withoutFlag.id } })).status).toBe("approved");
    expect(await receiptsOn(withoutFlag.poId)).toBe(0);
  });

  it("blocks self-approval but lets the preparer post someone else's approval", async () => {
    const d = await preparedDelivery({ preparer: fx.managerId });
    await prisma.tenantSettings.upsert({ where: { tenantId: fx.tenantId },
      create: { tenantId: fx.tenantId, selfApprovalRoleKeys: ["owner"] }, update: { selfApprovalRoleKeys: ["owner"] } });
    try {
      await expect(approvePrepared(d.id, fx.managerId)).rejects.toThrow();
      const approved = await approvePrepared(d.id, fx.ownerId);
      const posted = await prepared.post(user(fx.managerId), branch(), d.id, { approvalId: approved.executionApprovalId! });
      expect(posted.executedBy?.id).toBe(fx.managerId);
    } finally {
      await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner", "manager"] } });
    }
  });

  it("rechecks the approver's rights after an actual batch-lock wait", async () => {
    const batchNo = `LOCK-${randomUUID().slice(0, 6)}`;
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5, batchNo });
    const existing = await prisma.batch.findFirstOrThrow({ where: { id: batchId } });
    const d = await preparedDelivery({ batchNo });
    await prisma.preparedReceipt.update({ where: { id: d.id }, data: { payload: {
      lines: [{ ...deliveryLine(10, batchNo), expiryDate: existing.expiryDate.toISOString().slice(0, 10) }] } } });
    const approved = await approvePrepared(d.id);
    const locks = await holdBatchLocks([batchId]);
    const outcome = Promise.allSettled([prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: approved.executionApprovalId! })]);
    try {
      expect(await locks.waitedOn()).toBe(true);
      await setRole(fx.managerId, "cashier");
      locks.release();
      await locks.blocker;
      expect((await outcome)[0]!.status).toBe("rejected");
      expect(await receiptsOn(d.poId)).toBe(0);
      expect((await batchTotals(prisma, batchId)).onHand).toBe(5);
      expect((await prisma.preparedReceipt.findFirstOrThrow({ where: { id: d.id } })).status).toBe("approved");
    } finally {
      locks.release();
      await Promise.allSettled([locks.blocker, outcome]);
      await setRole(fx.managerId, "manager");
    }
  });

  it("rolls back stock, receipt, invoice and status when the success audit fails", async () => {
    const d = await preparedDelivery();
    const approved = await approvePrepared(d.id);
    audit.failOn = "purchase_order.prepared_receipt_posted";
    await expect(prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: approved.executionApprovalId! }))
      .rejects.toThrow(/Injected/);
    expect(await receiptsOn(d.poId)).toBe(0);
    expect(await placeholderInvoices(d.poId)).toBe(0);
    expect((await prisma.preparedReceipt.findFirstOrThrow({ where: { id: d.id } })).status).toBe("approved");
    audit.failOn = null;
    await prepared.post(user(fx.clerkId), branch(), d.id, { approvalId: approved.executionApprovalId! });
    expect(await receiptsOn(d.poId)).toBe(1);
  });

  it("keeps one open prepared delivery per order and needs live purchasing permission to prepare", async () => {
    const d = await preparedDelivery();
    await expect(prepared.create(user(fx.clerkId), branch(), d.poId, { delivery: { lines: [deliveryLine(1)] } }))
      .rejects.toMatchObject({ response: { code: "RECEIPT_ALREADY_PREPARED" } });
    await prepared.cancel(user(fx.managerId), branch(), d.id, { reason: "Supplier rescheduled" });
    await setRole(fx.clerkId, "cashier");
    try {
      // A cashier holds no purchasing permission, so the live check refuses preparing at all.
      await expect(prepared.create(user(fx.clerkId), branch(), d.poId, { delivery: { lines: [deliveryLine(1)] } }))
        .rejects.toThrow(/permission/i);
    } finally {
      await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, branchId: branch(), userId: fx.clerkId },
        data: { role: "inventory_clerk" } });
    }
  });
});

// ── supplier returns ────────────────────────────────────────────────────────────────

async function supplierReturn(opts: { qty?: number; stocked?: number; submitAs?: "clerk" | "manager" } = {}) {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: opts.stocked ?? 20 });
  const asManager = opts.submitAs === "manager";
  const requester = asManager ? fx.managerId : fx.clerkId;
  const created = await returns.create(user(requester), branch(),
    asManager ? actor(fx.managerId, "all", { canSelfApprove: true }) : actor(fx.clerkId, ["returns.create", "returns.process"]),
    { type: "supplier", supplierId: fx.supplierId, reason: "Damaged in transit", submit: true,
      items: [{ productId: fx.productId, batchId, qty: opts.qty ?? 4, unitPrice: 10 }] } as never);
  return { id: created.id, batchId, created };
}
const approveReturn = async (id: string, who = fx.managerId) => {
  const row = await returns.getOne(fx.tenantId, branch(), id);
  return returns.approve(user(who), branch(), id, { approvalId: randomUUID(), ...row.approvalReview! });
};
const debitNotes = (id: string) => prisma.supplierDebitNote.count({ where: { tenantId: fx.tenantId, goodsReturnId: id } });

describe("supplier returns: remote approval, counter dispatch", () => {
  it("approval records evidence only; dispatch issues stock and the debit note once", async () => {
    const r = await supplierReturn();
    expect(r.created.status).toBe("pending_approval");
    expect(r.created.executionApprovalId).toBeNull();
    const approved = await approveReturn(r.id);
    expect(approved.status).toBe("awaiting_logistics");
    expect(approved.executionApprovalId).toEqual(expect.any(String));
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(20);
    expect(await debitNotes(r.id)).toBe(0);

    await Promise.all([
      returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: approved.executionApprovalId! }),
      returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: approved.executionApprovalId! }),
    ]);
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(16);
    expect(await debitNotes(r.id)).toBe(1);
    expect(await audits("return.completed", r.id)).toBe(1);
    const done = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId, eventName: "return.completed", entityId: r.id } });
    expect(done.payload).toMatchObject({ requestedByUserId: fx.clerkId, approvedByUserId: fx.managerId,
      executedByUserId: fx.clerkId, approvalId: approved.executionApprovalId });
  });

  it("a self-approving submit records exact evidence in the same transaction", async () => {
    const r = await supplierReturn({ submitAs: "manager" });
    expect(r.created.status).toBe("awaiting_logistics");
    expect(r.created.executionApprovalId).toEqual(expect.any(String));
    await returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: r.created.executionApprovalId! });
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(16);
  });

  it("refuses a replaced approval and a legacy approval without evidence until approved again", async () => {
    const r = await supplierReturn();
    const first = await approveReturn(r.id);
    const second = await approveReturn(r.id, fx.ownerId);
    await expect(returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: first.executionApprovalId! }))
      .rejects.toThrow(/Approval changed/);

    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 6 });
    const legacy = await prisma.goodsReturn.create({ data: {
      tenantId: fx.tenantId, branchId: branch(), returnNumber: `RET-${randomUUID().slice(0, 6)}`, type: "supplier",
      status: "awaiting_logistics", supplierId: fx.supplierId, requestedBy: fx.clerkId, approvedBy: fx.managerId,
      items: { create: [{ tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 2, unitPrice: "10.00" }] },
    } });
    const view = await returns.getOne(fx.tenantId, branch(), legacy.id);
    expect(view.executionApprovalId).toBeNull();
    await expect(returns.complete(user(fx.clerkId), branch(), legacy.id, { approvalId: randomUUID() }))
      .rejects.toThrow(/Approval changed/);
    const reapproved = await approveReturn(legacy.id);
    await returns.complete(user(fx.clerkId), branch(), legacy.id, { approvalId: reapproved.executionApprovalId! });
    expect((await batchTotals(prisma, batchId)).onHand).toBe(4);
    await returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: second.executionApprovalId! });
  });

  it("refuses revoked evidence without moving stock", async () => {
    const r = await supplierReturn();
    const approved = await approveReturn(r.id);
    await tx((c) => approvals.revoke(c, user(fx.ownerId), branch(), approved.executionApprovalId!, "Supplier refused the return"));
    await expect(returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: approved.executionApprovalId! })).rejects.toThrow();
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(20);
    expect(await debitNotes(r.id)).toBe(0);
  });

  it("rechecks the approver's rights after an actual batch-lock wait", async () => {
    const r = await supplierReturn();
    const approved = await approveReturn(r.id);
    const locks = await holdBatchLocks([r.batchId]);
    const outcome = Promise.allSettled([returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: approved.executionApprovalId! })]);
    try {
      expect(await locks.waitedOn()).toBe(true);
      await setRole(fx.managerId, "cashier");
      locks.release();
      await locks.blocker;
      expect((await outcome)[0]!.status).toBe("rejected");
      expect((await batchTotals(prisma, r.batchId)).onHand).toBe(20);
      expect(await debitNotes(r.id)).toBe(0);
      expect((await prisma.goodsReturn.findFirstOrThrow({ where: { id: r.id } })).status).toBe("awaiting_logistics");
    } finally {
      locks.release();
      await Promise.allSettled([locks.blocker, outcome]);
      await setRole(fx.managerId, "manager");
    }
  });

  it("rolls back stock, debit note and status when the success audit fails", async () => {
    const r = await supplierReturn();
    const approved = await approveReturn(r.id);
    audit.failOn = "return.completed";
    await expect(returns.complete(user(fx.clerkId), branch(), r.id, { approvalId: approved.executionApprovalId! }))
      .rejects.toThrow(/Injected/);
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(20);
    expect(await debitNotes(r.id)).toBe(0);
    expect((await prisma.goodsReturn.findFirstOrThrow({ where: { id: r.id } })).status).toBe("awaiting_logistics");
  });
});

// ── signed terminal execution ───────────────────────────────────────────────────────

async function counterFor(who: string) {
  const owner = user(fx.ownerId);
  const device = terminalDevice();
  const counter = await tx((c) => trust.createCounter(c, owner, branch(), `Counter ${randomUUID().slice(0, 6)}`));
  const enrollment = await tx((c) => trust.beginEnrollment(c, owner, branch(), {
    registerId: counter.id, label: "Desk", keyId: randomUUID(), publicKeyHex: device.publicKeyHex,
  }));
  const identity = await tx((c) => trust.finishEnrollment(c, owner, branch(),
    device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment, "enrollment")));
  const staff = user(who);
  const sessionPayload = await tx((c) => trust.beginSession(c, staff, branch(), identity));
  const session = await tx((c) => trust.finishSession(c, staff, branch(),
    device.sign(sessionPayload, identity.keyId), attendance.allow(sessionPayload, "session")));
  return { device, identity, session, staff };
}
type Counter = Awaited<ReturnType<typeof counterFor>>;
async function signed(counter: Counter, operation: SignedPhysicalOperation, body: unknown, approvalEvidenceId: string) {
  const payload = await executor.prepare(counter.staff, branch(), {
    workSessionId: counter.session.workSessionId, operation, body, approvalEvidenceId,
    pharmacistEvidenceId: null, operatingHoursExceptionId: null,
  }) as OnlineTerminalCommand<unknown>;
  return { payload, request: { command: counter.device.sign(payload, counter.identity.keyId),
    attendanceProofId: attendance.allow(payload, "command") } };
}
const receiptsFor = (commandId: string) => prisma.terminalCommandReceipt.count({ where: { tenantId: fx.tenantId, commandId } });

describe("signed counter commands", () => {
  let counter: Counter;
  beforeAll(async () => { counter = await counterFor(fx.clerkId); });

  it("posts a prepared delivery once; a lost response replays the original receipt", async () => {
    const d = await preparedDelivery();
    const approved = await approvePrepared(d.id);
    const { payload, request } = await signed(counter, "POST /api/v1/purchasing/prepared-receipts/:id/post",
      { preparedReceiptId: d.id }, approved.executionApprovalId!);
    const [first, second] = await Promise.all([executor.execute(counter.staff, branch(), request),
      executor.execute(counter.staff, branch(), request)]);
    const original = first.replayed ? second : first;
    expect(original).toMatchObject({ replayed: false, result: { type: "prepared_receipt.posted", preparedReceiptId: d.id,
      approvalId: approved.executionApprovalId, effect: "applied" } });
    const retried = await executor.execute(counter.staff, branch(), request);
    expect({ ...retried, replayed: false }).toEqual(original);
    expect(await receiptsOn(d.poId)).toBe(1);
    expect(await receiptsFor(payload.commandId)).toBe(1);
    expect(await audits("purchase_order.prepared_receipt_posted", d.id)).toBe(1);
    const posted = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId,
      eventName: "purchase_order.prepared_receipt_posted", entityId: d.id } });
    expect(posted.payload).toMatchObject({ approvedByUserId: fx.managerId, executedByUserId: fx.clerkId,
      command: { commandId: payload.commandId, enrollmentId: counter.identity.enrollmentId,
        workSessionId: counter.session.workSessionId } });
  });

  it("dispatches a supplier return once and rolls everything back on an injected failure", async () => {
    const r = await supplierReturn();
    const approved = await approveReturn(r.id);
    const { payload, request } = await signed(counter, "POST /api/v1/returns/:id/complete",
      { goodsReturnId: r.id }, approved.executionApprovalId!);
    audit.failOn = "return.completed";
    await expect(executor.execute(counter.staff, branch(), request)).rejects.toThrow(/Injected/);
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(20);
    expect(await debitNotes(r.id)).toBe(0);
    expect(await receiptsFor(payload.commandId)).toBe(0);
    audit.failOn = null;
    const receipt = await executor.execute(counter.staff, branch(), request); // same envelope, still valid
    expect(receipt).toMatchObject({ replayed: false, result: { type: "goods_return.completed", goodsReturnId: r.id,
      approvalId: approved.executionApprovalId, debitNoteId: expect.any(String), effect: "applied" } });
    const replay = await executor.execute(counter.staff, branch(), request);
    expect(replay.replayed).toBe(true);
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(16);
    expect(await debitNotes(r.id)).toBe(1);
    expect(await receiptsFor(payload.commandId)).toBe(1);
  });

  it("refuses a command whose approval is not the document's current one", async () => {
    const r = await supplierReturn();
    const first = await approveReturn(r.id);
    await approveReturn(r.id, fx.ownerId);
    const { payload, request } = await signed(counter, "POST /api/v1/returns/:id/complete",
      { goodsReturnId: r.id }, first.executionApprovalId!);
    await expect(executor.execute(counter.staff, branch(), request)).rejects.toThrow();
    expect((await batchTotals(prisma, r.batchId)).onHand).toBe(20);
    expect(await receiptsFor(payload.commandId)).toBe(0);
  });
});
