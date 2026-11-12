import { randomUUID } from "node:crypto";
import { AuditService } from "../../src/audit/audit.service";
import { AdjustmentService } from "../../src/inventory/adjustment.service";
import { InventoryService } from "../../src/inventory/inventory.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { HeldDeliveryService } from "../../src/purchasing/held-delivery.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { CounterWorkService } from "../../src/terminal-commands/counter-work.service";
import { createPrisma, createStockedBatch, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const stock = new StockService();
const read = new StockReadService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const approvals = new ManagementApprovalsService(access, audit);
const notifications = { notifyByPermission: jest.fn().mockResolvedValue(1), notifyUser: jest.fn().mockResolvedValue(undefined) };
const adjustments = new AdjustmentService(prisma as never,
  new InventoryService(prisma as never, audit, stock, read), notifications as never, audit, access, approvals);
const deliveries = new HeldDeliveryService(prisma as never,
  new PurchasingService(prisma as never, audit, stock, read), notifications as never, audit, access, approvals);
// Refund requests have their own integration tests; here the list only needs to be callable.
// The route resolves real role grants; no cache, so a role change in a test applies at once.
const permissions = new PermissionsService(prisma as never, { get: () => 0 } as never);
const work = new CounterWorkService(prisma as never, new AccessService(prisma as never, permissions),
  { list: async () => [] } as never);

let fx: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (id: string): RequestUser => ({ tenantId: fx.tenantId, userId: id, tokenVersion: 0,
  branchRoles: [], email: "work@it.test", fullName: "Counter work", authMethod: "bearer" });

/** The caller as the guards build it: the request carries their roles at each branch. */
async function caller(id: string): Promise<RequestUser> {
  const roles = await prisma.userBranchRole.findMany({ where: { tenantId: fx.tenantId, userId: id } });
  return { ...user(id), branchRoles: roles.map((r) => ({ branchId: r.branchId, role: r.role, roleId: r.roleId })) };
}

async function approvedWriteOff() {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
  const { heldAdjustment } = await adjustments.request(user(fx.clerkId), branch(), {
    productId: fx.productId, batchId, qty: 2, kind: "lost", reason: "Missing during count",
  });
  const review = (await adjustments.listHeld(fx.tenantId, branch(), true)).find((r) => r.id === heldAdjustment.id)!.approvalReview;
  const accepted = await adjustments.accept(user(fx.managerId), branch(), heldAdjustment.id, { approvalId: randomUUID(), ...review });
  return { id: heldAdjustment.id, approvalId: accepted.executionApprovalId! };
}

async function approvedDelivery() {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
  const batch = await prisma.batch.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: batchId } });
  const po = await prisma.purchaseOrder.create({ data: {
    tenantId: fx.tenantId, branchId: branch(), supplierId: fx.supplierId, createdBy: fx.clerkId,
    poNumber: `PO-${randomUUID().slice(0, 8)}`, status: "issued", items: { create: { tenantId: fx.tenantId,
      productId: fx.productId, orderedQty: 1, unitCost: "10.00", taxPercent: 0 } },
  } });
  const held = await deliveries.hold(fx.tenantId, branch(), fx.clerkId, po.id, {
    reasons: ["over_delivery"], detail: "Two delivered, one ordered", delivery: { purchaseOrderId: po.id,
      receivedOn: daysFromToday(0).toISOString().slice(0, 10), lines: [{ productId: fx.productId,
        batchNo: batch.batchNo, expiryDate: batch.expiryDate.toISOString(), receivedQty: 2, costPrice: "10.00", sellingPrice: "15.00" }] },
  });
  const review = (await deliveries.list(fx.tenantId, branch(), { canViewCost: true })).find((r) => r.id === held.held.id)!.approvalReview;
  await deliveries.accept(user(fx.managerId), branch(), held.held.id, { approvalId: randomUUID(), ...review });
  return { id: held.held.id, poNumber: po.poNumber };
}

beforeAll(async () => {
  fx = await createTenant(prisma, "counter-work");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.clerkId, role: "inventory_clerk" },
  ] });
});
afterAll(async () => { await prisma.$disconnect(); });

describe("web-approved work waiting at the counter", () => {
  it("lists approved held work with requester, approver and the approved version, matching", async () => {
    const writeOff = await approvedWriteOff();
    const delivery = await approvedDelivery();
    const items = await work.list(await caller(fx.ownerId), branch());

    const adj = items.find((i) => i.id === writeOff.id)!;
    expect(adj).toMatchObject({
      kind: "held_adjustment",
      operation: "POST /api/v1/inventory/held-adjustments/:id/post",
      requested: { name: expect.stringMatching(/^clerk /) },
      approved: { name: expect.stringMatching(/^manager /) },
      approval: { evidenceId: writeOff.approvalId, state: "matches", changes: [] },
    });
    expect(adj.approval.approvedVersion).toBe(adj.approval.currentVersion);
    expect(adj.task).toMatchObject({
      stage: "ready_for_execution",
      dailyWorkKind: "held_adjustment.post",
      destination: "held_write_off",
      destinationStatus: "planned",
      freshness: { stale: false },
      signedExecution: { bodyIdKey: "heldAdjustmentId", approvalEvidenceId: writeOff.approvalId },
    });
    expect(adj.task.nextAction.executable).toBe(false);

    expect(items.find((i) => i.id === delivery.id)).toMatchObject({
      kind: "held_delivery",
      reference: delivery.poNumber,
      subject: "Integration Supplier",
      lineCount: 1,
      amount: "20.00",
      approval: { state: "matches" },
    });
    // Nothing on another branch's counter.
    expect((await work.list(await caller(fx.ownerId), fx.otherBranchId)).map((i) => i.id)).not.toContain(writeOff.id);
  });

  it("lists each kind only to someone who may execute it here, and withholds costs", async () => {
    const writeOff = await approvedWriteOff();
    const delivery = await approvedDelivery();
    await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId }, data: { role: "cashier" } });
    try {
      const ids = (await work.list(await caller(fx.clerkId), branch())).map((i) => i.id);
      // A cashier can neither write off stock nor receive deliveries.
      expect(ids).not.toContain(writeOff.id);
      expect(ids).not.toContain(delivery.id);
    } finally {
      await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId }, data: { role: "inventory_clerk" } });
    }
    const clerk = await work.list(await caller(fx.clerkId), branch());
    expect(clerk.map((i) => i.id)).not.toContain(writeOff.id);
    expect(clerk.find((i) => i.id === delivery.id)).toBeDefined();
  });

  it("transfer_receive task pins dispatch approval, not approvalEvidenceId", async () => {
    const dispatchApprovalId = randomUUID();
    const transfer = await prisma.transfer.create({
      data: {
        tenantId: fx.tenantId,
        fromBranchId: fx.otherBranchId,
        toBranchId: branch(),
        transferNumber: `TR-${randomUUID().slice(0, 8)}`,
        status: "in_transit",
        requestedBy: fx.clerkId,
        dispatchedBy: fx.clerkId,
        dispatchedAt: new Date(),
        executionApprovalId: dispatchApprovalId,
        items: { create: { tenantId: fx.tenantId, productId: fx.productId, qty: 3 } },
      },
    });
    const row = (await work.list(await caller(fx.ownerId), branch())).find((i) => i.id === transfer.id)!;
    expect(row.kind).toBe("transfer_receive");
    expect(row.task.signedExecution).toMatchObject({
      approvalEvidenceId: null,
      dispatchApprovalId: dispatchApprovalId,
    });
  });

  it("says what changed after approval, and when the approval was withdrawn", async () => {
    // Editing the document itself clears its approval (a database trigger), so it leaves the
    // queue. What can move underneath it is the order a held delivery was approved against.
    const changed = await approvedDelivery();
    const held = await prisma.heldDelivery.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: changed.id } });
    await prisma.purchaseOrder.update({ where: { id: held.purchaseOrderId, tenantId: fx.tenantId },
      data: { approvalVersion: { increment: 1 } } });
    const revoked = await approvedWriteOff();
    await prisma.$transaction((tx) => approvals.revoke(tx, user(fx.ownerId), branch(), revoked.approvalId, "Review withdrawn"));

    const items = await work.list(await caller(fx.ownerId), branch());
    const moved = items.find((i) => i.id === changed.id)!;
    expect(moved.approval).toMatchObject({ state: "changed", changes: ["the purchase order"] });
    expect(moved.task.stage).toBe("blocked_approval");
    expect(moved.task.blocker?.code).toBe("APPROVAL_STALE");
    expect(moved.task.executeErrors).toEqual([
      { phase: "prepare", code: "APPROVAL_STALE" },
      { phase: "execute", code: "APPROVAL_STALE" },
    ]);
    const revokedItem = items.find((i) => i.id === revoked.id)!;
    expect(revokedItem.approval.state).toBe("revoked");
    expect(revokedItem.task.blocker?.code).toBe("APPROVAL_INVALID");
  });
});
