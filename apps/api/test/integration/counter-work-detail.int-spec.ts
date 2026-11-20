import { randomUUID } from "node:crypto";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { StockMovementType } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { ProductImportService } from "../../src/product-import/product-import.service";
import { HeldDeliveryService } from "../../src/purchasing/held-delivery.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { PermissionsService } from "../../src/security/permissions.service";
import { CounterWorkDetailService } from "../../src/terminal-commands/counter-work-detail.service";
import { CounterWorkService } from "../../src/terminal-commands/counter-work.service";
import { createPrisma, createStockedBatch, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const stock = new StockService();
const read = new StockReadService(prisma as never);
const approvals = new ManagementApprovalsService(new AccessService(prisma as never, {} as never), audit);
const notifications = { notifyByPermission: jest.fn().mockResolvedValue(1), notifyUser: jest.fn().mockResolvedValue(undefined) };
const deliveries = new HeldDeliveryService(prisma as never,
  new PurchasingService(prisma as never, audit, stock, read), notifications as never, audit,
  new AccessService(prisma as never, {} as never), approvals);
const permissions = new PermissionsService(prisma as never, { get: () => 0 } as never);
const access = new AccessService(prisma as never, permissions);
const work = new CounterWorkService(prisma as never, access, { list: async () => [] } as never);
// The undo list reads only through Prisma; the import pipeline itself is not exercised here.
const imports = new ProductImportService(prisma as never, audit, {} as never, {} as never, {} as never, stock, {} as never);
// Stocktake reads have their own integration tests (stocktake-count-time); not needed here.
const details = new CounterWorkDetailService(prisma as never, access, work, {} as never, imports);

let fx: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (id: string): RequestUser => ({ tenantId: fx.tenantId, userId: id, tokenVersion: 0,
  branchRoles: [], email: "detail@it.test", fullName: "Counter detail", authMethod: "bearer" });

async function caller(id: string): Promise<RequestUser> {
  const roles = await prisma.userBranchRole.findMany({ where: { tenantId: fx.tenantId, userId: id } });
  return { ...user(id), branchRoles: roles.map((r) => ({ branchId: r.branchId, role: r.role, roleId: r.roleId })) };
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
      receivedOn: daysFromToday(0).toISOString().slice(0, 10), supplierDeliveryNote: "DN-77", lines: [{
        productId: fx.productId, batchNo: batch.batchNo, expiryDate: batch.expiryDate.toISOString(),
        receivedQty: 2, freeQty: 1, costPrice: "10.00", sellingPrice: "15.00" }] },
  });
  const review = (await deliveries.list(fx.tenantId, branch(), { canViewCost: true })).find((r) => r.id === held.held.id)!.approvalReview;
  await deliveries.accept(user(fx.managerId), branch(), held.held.id, { approvalId: randomUUID(), ...review });
  return { id: held.held.id, poNumber: po.poNumber, batch };
}

/** An import that uploaded stock straight onto a batch, as the upload with stock does. */
async function importWithStock(qty = 12) {
  const importId = randomUUID();
  await prisma.productImport.create({ data: {
    id: importId, tenantId: fx.tenantId, branchId: branch(), createdBy: fx.ownerId, filename: `stock-${importId.slice(0, 6)}.xlsx`,
    status: "completed", completedAt: new Date(), batchesCreated: 1, unitsPosted: qty,
  } });
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 0 });
  await prisma.$transaction((tx) => stock.receive(tx,
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, referenceType: "product_import", referenceId: importId },
    [{ productId: fx.productId, batchId, qty, movementType: StockMovementType.opening_stock }]));
  return { importId, batchId };
}

beforeAll(async () => {
  fx = await createTenant(prisma, "counter-work-detail");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.clerkId, role: "inventory_clerk" },
  ] });
});
afterAll(async () => { await prisma.$disconnect(); });

describe("counter reads: the lines behind one Counter work item", () => {
  it("reads a held delivery's approved lines, why it was held, and the same approval check as the list", async () => {
    const delivery = await approvedDelivery();
    // One clock for both reads, as the controller stamps one per response.
    const asOf = new Date().toISOString();
    const detail = await details.detail(await caller(fx.ownerId), branch(), "held_delivery", delivery.id, asOf);
    const listed = (await work.list(await caller(fx.ownerId), branch(), asOf)).find((i) => i.id === delivery.id)!;

    expect(detail).toMatchObject({
      kind: "held_delivery",
      reference: delivery.poNumber,
      supplierDeliveryNote: "DN-77",
      approval: listed.approval,
      held: { reasons: ["over_delivery"], detail: "Two delivered, one ordered", corrected: false },
      requested: { name: expect.stringMatching(/^clerk /) },
      approved: { name: expect.stringMatching(/^manager /) },
    });
    expect(detail.task).toEqual(listed.task);
    expect(detail.notes[0]).toMatchObject({ label: "Why it was held", text: "Two delivered, one ordered" });
    if (detail.kind !== "held_delivery") throw new Error("kind");
    expect(detail.lines).toEqual([expect.objectContaining({
      index: 0, productId: fx.productId, batchNo: delivery.batch.batchNo,
      expiryDate: delivery.batch.expiryDate.toISOString().slice(0, 10),
      receivedQty: 2, freeQty: 1, damagedQty: 0, unitsToStock: 3, unitCost: "10.00",
    })]);
  });

  it("withholds costs from someone without costs.view", async () => {
    const delivery = await approvedDelivery();
    // Built-in clerks see costs by default, so receive with a role that may receive but not see costs.
    await prisma.permission.createMany({ data: [{ key: "purchasing.receive", module: "purchasing",
      label: "purchasing.receive", description: "Integration test permission" }], skipDuplicates: true });
    const role = await prisma.role.create({ data: { tenantId: fx.tenantId, key: `receive-only-${randomUUID()}`,
      name: "Receive only", permissions: { create: [{ tenantId: fx.tenantId, permissionKey: "purchasing.receive" }] } } });
    const before = await prisma.userBranchRole.findMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId } });
    await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId }, data: { roleId: role.id } });
    try {
      const detail = await details.detail(await caller(fx.clerkId), branch(), "held_delivery", delivery.id);
      if (detail.kind !== "held_delivery") throw new Error("kind");
      expect(detail.amount).toBeNull();
      expect(detail.lines[0].unitCost).toBeNull();
      expect(detail.lines[0].packCost).toBeNull();
      expect(detail.lines[0].receivedQty).toBe(2);
    } finally {
      for (const row of before)
        await prisma.userBranchRole.update({ where: { id: row.id }, data: { roleId: row.roleId } });
    }
  });

  it("refuses without the operation's permission, and 404s outside this branch's queue", async () => {
    const delivery = await approvedDelivery();
    await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId }, data: { role: "cashier" } });
    try {
      await expect(details.detail(await caller(fx.clerkId), branch(), "held_delivery", delivery.id))
        .rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId }, data: { role: "inventory_clerk" } });
    }
    // Another branch's counter, the wrong kind, and an unknown id all read as "not waiting here".
    await expect(details.detail(await caller(fx.ownerId), fx.otherBranchId, "held_delivery", delivery.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(details.detail(await caller(fx.ownerId), branch(), "prepared_receipt", delivery.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(details.detail(await caller(fx.ownerId), branch(), "held_delivery", randomUUID()))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("reads a transfer on its way in with what has arrived and what is still to come", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 0, branchId: fx.otherBranchId });
    const transfer = await prisma.transfer.create({ data: {
      tenantId: fx.tenantId, fromBranchId: fx.otherBranchId, toBranchId: branch(),
      transferNumber: `TR-${randomUUID().slice(0, 8)}`, status: "partially_received", notes: "Fragile",
      requestedBy: fx.clerkId, dispatchedBy: fx.managerId, dispatchedAt: new Date(),
      items: { create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 5, receivedQty: 2 } },
    } });
    const detail = await details.detail(await caller(fx.ownerId), branch(), "transfer_receive", transfer.id);
    if (detail.kind !== "transfer_receive") throw new Error("kind");
    const other = await prisma.branch.findFirstOrThrow({ where: { id: fx.otherBranchId } });
    expect(detail.otherBranch).toBe(other.name);
    expect(detail.dispatched).toMatchObject({ name: expect.stringMatching(/^manager /) });
    expect(detail.notes).toEqual([expect.objectContaining({ label: "Transfer note", text: "Fragile" })]);
    expect(detail.lines).toEqual([expect.objectContaining({ batchId, qty: 5, receivedQty: 2, remainingQty: 3 })]);
  });

  it("reads staged opening stock by category, with posted categories marked", async () => {
    const importId = randomUUID();
    const rows = [
      { rowNumber: 2, productId: fx.productId, name: "x", categoryName: "Analgesics", qty: 10, costPrice: 4, sellingPrice: 6, batchNo: "A1", expiryDate: "2027-06-30", postedBatchId: randomUUID() },
      { rowNumber: 3, productId: fx.productId, name: "x", categoryName: "Antibiotics", qty: 5, costPrice: 4, sellingPrice: 6, batchNo: "B1", expiryDate: "2027-06-30" },
      { rowNumber: 4, productId: fx.productId, name: "x", categoryName: "Antibiotics", qty: 7, costPrice: 4, sellingPrice: 6, batchNo: "B1", expiryDate: "2027-06-30" },
    ];
    await prisma.productImport.create({ data: {
      id: importId, tenantId: fx.tenantId, branchId: branch(), createdBy: fx.ownerId, filename: "opening.xlsx",
      status: "completed", completedAt: new Date(), stockStaged: true, stockStagedBy: fx.ownerId, stagedStock: rows,
    } });
    const detail = await details.detail(await caller(fx.ownerId), branch(), "import_stock", importId);
    if (detail.kind !== "import_stock") throw new Error("kind");
    expect(detail.stockVersion).toBe(1);
    expect(detail.categories).toEqual([
      { categoryName: "Analgesics", rows: 1, batches: 1, units: 10, posted: true },
      { categoryName: "Antibiotics", rows: 2, batches: 1, units: 12, posted: false },
    ]);
    expect(detail.rows.map((r) => [r.rowNumber, r.unitCost, r.posted])).toEqual([[2, "4.00", true], [3, "4.00", false], [4, "4.00", false]]);
  });
});

describe("counter reads: imports this counter can still undo (decision 5)", () => {
  it("lists an untouched import with the stock it posted, and drops it once that stock moves", async () => {
    const { importId, batchId } = await importWithStock(12);
    const listed = (await details.undoableImports(await caller(fx.ownerId), branch())).find((i) => i.importId === importId)!;
    expect(listed).toMatchObject({
      batches: 1, units: 12,
      uploaded: { name: expect.stringMatching(/^owner /) },
      lines: [expect.objectContaining({ batchId, qty: 12, newProduct: false })],
    });
    // Not on another branch's counter.
    expect((await details.undoableImports(await caller(fx.ownerId), fx.otherBranchId)).map((i) => i.importId))
      .not.toContain(importId);

    await prisma.$transaction((tx) => stock.issue(tx,
      { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: fx.productId, batchId, qty: 1, movementType: StockMovementType.adjustment_out }]));
    expect((await details.undoableImports(await caller(fx.ownerId), branch())).map((i) => i.importId)).not.toContain(importId);
  });

  it("lists nothing to someone without products.import", async () => {
    await importWithStock(3);
    await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId }, data: { role: "cashier" } });
    try {
      expect(await details.undoableImports(await caller(fx.clerkId), branch())).toEqual([]);
    } finally {
      await prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, userId: fx.clerkId }, data: { role: "inventory_clerk" } });
    }
  });
});
