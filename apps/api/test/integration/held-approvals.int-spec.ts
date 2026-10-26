import { randomUUID } from "node:crypto";
import { AuditService } from "../../src/audit/audit.service";
import { AdjustmentService } from "../../src/inventory/adjustment.service";
import { InventoryService } from "../../src/inventory/inventory.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { HeldDeliveryService } from "../../src/purchasing/held-delivery.service";
import { AccessService } from "../../src/security/access.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { actor, batchTotals, createPrisma, createStockedBatch, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

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
let fx: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (id: string): RequestUser => ({ tenantId: fx.tenantId, userId: id, tokenVersion: 0,
  branchRoles: [], email: "held@it.test", fullName: "Held actor", authMethod: "bearer" });
type Kind = "adjustment" | "delivery";
async function fixture(kind: Kind, requester = fx.clerkId) {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
  if (kind === "adjustment") {
    const result = await adjustments.adjust(fx.tenantId, branch(), actor(requester, ["inventory.manage"]), {
      productId: fx.productId, batchId, qty: 2, kind: "lost", reason: "Missing during count",
    });
    return { id: (result as { heldAdjustment: { id: string } }).heldAdjustment.id, batchId, poId: "" };
  }
  const batch = await prisma.batch.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: batchId } });
  const po = await prisma.purchaseOrder.create({ data: {
    tenantId: fx.tenantId, branchId: branch(), supplierId: fx.supplierId, createdBy: fx.clerkId,
    poNumber: randomUUID(), status: "issued", items: { create: { tenantId: fx.tenantId,
      productId: fx.productId, orderedQty: 1, unitCost: "10.00", taxPercent: 0 } },
  } });
  const held = await deliveries.hold(fx.tenantId, branch(), requester, po.id, {
    reasons: ["over_delivery"], detail: "Two delivered, one ordered", delivery: { purchaseOrderId: po.id,
      receivedOn: daysFromToday(0).toISOString().slice(0, 10), lines: [{ productId: fx.productId,
        batchNo: batch.batchNo, expiryDate: batch.expiryDate.toISOString(), receivedQty: 2, costPrice: "10.00", sellingPrice: "15.00" }] },
  });
  return { id: held.held.id, batchId, poId: po.id };
}
async function input(kind: Kind, id: string) {
  const rows = kind === "adjustment" ? await adjustments.listHeld(fx.tenantId, branch(), true)
    : await deliveries.list(fx.tenantId, branch(), { canViewCost: true });
  return { approvalId: randomUUID(), ...rows.find(row => row.id === id)!.approvalReview };
}
const accept = async (kind: Kind, id: string, who = fx.managerId, exact?: Awaited<ReturnType<typeof input>>) =>
  (kind === "adjustment" ? adjustments : deliveries).accept(user(who), branch(), id, exact ?? await input(kind, id));
const post = async (kind: Kind, id: string, who = fx.ownerId) => (kind === "adjustment" ? adjustments : deliveries).post(user(who), branch(), id, { approvalId: (await saved(kind, id)).executionApprovalId! });
const saved = (kind: Kind, id: string) => kind === "adjustment"
  ? prisma.heldAdjustment.findFirstOrThrow({ where: { tenantId: fx.tenantId, id } })
  : prisma.heldDelivery.findFirstOrThrow({ where: { tenantId: fx.tenantId, id } });
const eventName = (kind: Kind, phase: string) => kind === "adjustment" ? `inventory.write_off_${phase}` : `purchase_order.held_delivery_${phase}`;

beforeAll(async () => {
  fx = await createTenant(prisma, "held-approvals");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.clerkId, role: "inventory_clerk" },
  ] });
});
afterAll(async () => { await prisma.$disconnect(); });
afterEach(() => jest.restoreAllMocks());

describe.each<Kind>(["adjustment", "delivery"])("exact held %s approval", kind => {
  it("rejects a stale posting confirmation after approval is replaced", async () => {
    const c = await fixture(kind); const old = await accept(kind, c.id);
    await accept(kind, c.id, fx.ownerId);
    await expect((kind === "adjustment" ? adjustments : deliveries).post(user(fx.ownerId), branch(), c.id,
      { approvalId: old.executionApprovalId! })).rejects.toThrow(/Approval changed/);
    expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
    await post(kind, c.id);
  });
  it("blocks self-approval but lets the requester execute another person's approval", async () => {
    const c = await fixture(kind, fx.managerId);
    await prisma.tenantSettings.upsert({ where: { tenantId: fx.tenantId },
      create: { tenantId: fx.tenantId, selfApprovalRoleKeys: ["owner"] }, update: { selfApprovalRoleKeys: ["owner"] } });
    try {
      await expect(accept(kind, c.id)).rejects.toThrow();
      await accept(kind, c.id, fx.ownerId); await post(kind, c.id, fx.managerId);
      expect((await saved(kind, c.id)).executedBy).toBe(fx.managerId);
    } finally { await prisma.tenantSettings.update({ where: { tenantId: fx.tenantId }, data: { selfApprovalRoleKeys: ["owner", "manager"] } }); }
  });
  it("rechecks approval rights after an actual batch-lock wait", async () => {
    const c = await fixture(kind); await accept(kind, c.id);
    let release!: () => void; let ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<number>(resolve => { ready = resolve; });
    const blocker = prisma.$transaction(async tx => {
      await stock.lockBatches(tx, fx.tenantId, [c.batchId]);
      const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      ready(rows[0]!.pid); await gate;
    }, { timeout: 15_000 });
    const pid = await acquired;
    const outcome = Promise.allSettled([post(kind, c.id)]);
    try {
      let waited = false;
      for (let i = 0; i < 80; i++) {
        const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::integer = ANY(pg_blocking_pids(pid))) AS waiting`;
        if (rows[0]!.waiting) { waited = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waited).toBe(true);
      await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.managerId }, data: { role: "cashier" } });
      release(); await blocker;
      expect((await outcome)[0]!.status).toBe("rejected");
      expect((await saved(kind, c.id)).status).toBe("approved");
      expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
      expect(await prisma.goodsReceipt.count({ where: { tenantId: fx.tenantId, purchaseOrderId: c.poId || randomUUID() } })).toBe(0);
    } finally {
      release(); await Promise.allSettled([blocker, outcome]);
      await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.managerId }, data: { role: "manager" } });
    }
  });

  it("rejects revoked evidence without posting", async () => {
    const c = await fixture(kind); const accepted = await accept(kind, c.id);
    await prisma.$transaction(tx => approvals.revoke(tx, user(fx.ownerId), branch(), accepted.executionApprovalId!, "Review withdrawn"));
    await expect(post(kind, c.id)).rejects.toThrow();
    expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
  });
  it("approves without physical effects, then posts exactly once with separate attribution", async () => {
    const c = await fixture(kind); const exact = await input(kind, c.id);
    await Promise.all([accept(kind, c.id, fx.managerId, exact), accept(kind, c.id, fx.managerId, exact)]);
    expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
    expect((await saved(kind, c.id)).status).toBe("approved");
    expect(await prisma.goodsReceipt.count({ where: { tenantId: fx.tenantId, purchaseOrderId: c.poId || randomUUID() } })).toBe(0);
    await Promise.all([post(kind, c.id), post(kind, c.id)]);
    expect((await batchTotals(prisma, c.batchId)).onHand).toBe(kind === "adjustment" ? 18 : 22);
    expect((await saved(kind, c.id)).executedBy).toBe(fx.ownerId);
    expect(await prisma.auditEvent.count({ where: { tenantId: fx.tenantId, entityId: c.id, eventName: eventName(kind, "posted") } })).toBe(1);
  });

  it.each(["approved", "posted"])("rolls back all effects if the %s audit fails", async phase => {
    const c = await fixture(kind);
    if (phase === "posted") await accept(kind, c.id);
    const original = audit.log.bind(audit);
    jest.spyOn(audit, "log").mockImplementation(async (event, tx) => {
      if (event.eventName === eventName(kind, phase)) throw new Error("audit unavailable");
      return original(event, tx);
    });
    await expect(phase === "approved" ? accept(kind, c.id) : post(kind, c.id)).rejects.toThrow("audit unavailable");
    expect((await saved(kind, c.id)).status).toBe(phase === "approved" ? "awaiting_approval" : "approved");
    expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
    expect(await prisma.goodsReceipt.count({ where: { tenantId: fx.tenantId, purchaseOrderId: c.poId || randomUUID() } })).toBe(0);
    if (phase === "approved") expect(await prisma.managementApproval.count({ where: { tenantId: fx.tenantId, documentId: c.id } })).toBe(0);
  });

  it("retains evidence and supports explicit replacement after approver rights are removed", async () => {
    const c = await fixture(kind); const original = await accept(kind, c.id);
    await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.managerId }, data: { role: "cashier" } });
    try {
      await expect(post(kind, c.id)).rejects.toThrow();
      const replacement = await accept(kind, c.id, fx.ownerId);
      expect(replacement.executionApprovalId).not.toBe(original.executionApprovalId);
      expect(await prisma.managementApproval.count({ where: { tenantId: fx.tenantId, documentId: c.id } })).toBe(2);
      await post(kind, c.id);
    } finally { await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.managerId }, data: { role: "manager" } }); }
  });

  it("preserves notes but invalidates a changed-and-restored payload", async () => {
    const c = await fixture(kind); await accept(kind, c.id); const old = await saved(kind, c.id);
    if (kind === "adjustment") {
      await prisma.heldAdjustment.update({ where: { id: c.id, tenantId: fx.tenantId }, data: { note: "Administrative follow-up" } });
      expect((await saved(kind, c.id)).executionApprovalId).toBe(old.executionApprovalId);
      await prisma.heldAdjustment.update({ where: { id: c.id, tenantId: fx.tenantId }, data: { qty: 3 } });
      await prisma.heldAdjustment.update({ where: { id: c.id, tenantId: fx.tenantId }, data: { qty: 2 } });
    } else {
      await prisma.heldDelivery.update({ where: { id: c.id, tenantId: fx.tenantId }, data: { detail: "Administrative follow-up" } });
      expect((await saved(kind, c.id)).executionApprovalId).toBe(old.executionApprovalId);
      await prisma.heldDelivery.update({ where: { id: c.id, tenantId: fx.tenantId }, data: { reasons: ["price_variance"] } });
      await prisma.heldDelivery.update({ where: { id: c.id, tenantId: fx.tenantId }, data: { reasons: ["over_delivery"] } });
    }
    expect((await saved(kind, c.id)).approvalVersion).toBeGreaterThan(old.approvalVersion);
    await expect(post(kind, c.id)).rejects.toThrow();
  });

  it("enforces existing self-approval policy and rejects wrong-branch execution", async () => {
    const c = await fixture(kind);
    await expect(accept(kind, c.id, fx.clerkId)).rejects.toThrow();
    await accept(kind, c.id);
    await expect((kind === "adjustment" ? adjustments : deliveries).post(user(fx.ownerId), fx.otherBranchId, c.id, { approvalId: (await saved(kind, c.id)).executionApprovalId! })).rejects.toThrow();
    expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
  });
});

it("keeps an approved write-off intact when later sales leave insufficient stock", async () => {
  const c = await fixture("adjustment"); await accept("adjustment", c.id);
  await prisma.$transaction(tx => stock.issue(tx, { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId,
    referenceType: "sale", referenceId: randomUUID() }, [{ productId: fx.productId, batchId: c.batchId, qty: 19, movementType: "sale_out" }]));
  await expect(post("adjustment", c.id)).rejects.toThrow();
  expect((await saved("adjustment", c.id)).status).toBe("approved");
  expect((await batchTotals(prisma, c.batchId)).onHand).toBe(1);
});

it("invalidates a delivery approval when the PO material changes", async () => {
  const c = await fixture("delivery"); await accept("delivery", c.id);
  await prisma.purchaseOrder.update({ where: { id: c.poId, tenantId: fx.tenantId, branchId: branch() }, data: { supplierReference: "Revised agreement" } });
  await expect(post("delivery", c.id)).rejects.toThrow();
  expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
  await accept("delivery", c.id, fx.ownerId); await post("delivery", c.id, fx.clerkId);
});

it("blocks an alternate receipt while a delivery is approved but unposted", async () => {
  const c = await fixture("delivery"); await accept("delivery", c.id);
  const row = await prisma.heldDelivery.findFirstOrThrow({ where: { id: c.id, tenantId: fx.tenantId } });
  const purchasing = new PurchasingService(prisma as never, audit, stock, read);
  await expect(purchasing.receiveGoods(fx.tenantId, branch(), fx.ownerId, actor(fx.ownerId, "all"), row.payload as never)).rejects.toThrow(/waiting for approval|saved delivery/);
  expect((await batchTotals(prisma, c.batchId)).onHand).toBe(20);
});
