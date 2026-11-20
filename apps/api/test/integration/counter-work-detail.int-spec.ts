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
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { StocktakesService } from "../../src/stocktakes/stocktakes.service";
import { actor, createPrisma, createStockedBatch, createTenant, daysFromToday, type TenantFixture } from "./fixtures";

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
const proxy = createTenantAwarePrismaProxy(prisma);
const stocktakes = new StocktakesService(proxy as never, audit, stock, access, approvals);
const details = new CounterWorkDetailService(prisma as never, access, work, stocktakes, imports);

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

/** Counted, reviewed and approved on the web, as the counter finds it. */
async function approvedStocktake(countedQty: number, stocked: number) {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: stocked });
  const counter = actor(fx.clerkId, ["stocktakes.use"]);
  const reviewer = actor(fx.managerId, "all", { canSelfApprove: true });
  const created = await stocktakes.create(fx.tenantId, branch(), fx.clerkId,
    { scope: "custom", batchIds: [batchId], counterIds: [fx.clerkId] }, counter);
  await stocktakes.start(fx.tenantId, branch(), fx.clerkId, created.id, counter);
  await stocktakes.upsertLines(fx.tenantId, branch(), fx.clerkId, created.id, { lines: [{ batchId, countedQty }] }, counter);
  await stocktakes.submit(fx.tenantId, branch(), fx.clerkId, created.id, counter);
  await stocktakes.startReview(fx.tenantId, branch(), fx.managerId, created.id, reviewer);
  const detail = await stocktakes.getOne(fx.tenantId, branch(), created.id, reviewer);
  await stocktakes.reviewLines(fx.tenantId, branch(), fx.managerId, created.id,
    { lines: [{ lineId: detail.lines[0]!.id, reviewReason: "counting_error" }] }, reviewer);
  const fresh = await stocktakes.getOne(fx.tenantId, branch(), created.id, reviewer);
  await stocktakes.approve(await caller(fx.ownerId), branch(), created.id, { approvalId: randomUUID(), ...fresh.approvalReview! });
  return { id: created.id, batchId };
}

async function onHand(batchId: string) {
  return (await prisma.batchStock.findFirstOrThrow({ where: { tenantId: fx.tenantId, batchId } })).onHandQty;
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

  it("is a 404 to another tenant, even with the document's id", async () => {
    const delivery = await approvedDelivery();
    const foreign = await createTenant(prisma, "counter-detail-foreign");
    await prisma.userBranchRole.create({ data: { tenantId: foreign.tenantId, branchId: foreign.mainBranchId,
      userId: foreign.ownerId, role: "owner" } });
    const outsider: RequestUser = { ...user(foreign.ownerId), tenantId: foreign.tenantId,
      branchRoles: [{ branchId: foreign.mainBranchId, role: "owner", roleId: null }] };
    await expect(details.detail(outsider, foreign.mainBranchId, "held_delivery", delivery.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("reads a prepared receipt as posting will write it: the order's pack size and cost fill gaps", async () => {
    const batchNo = `PR-${randomUUID().slice(0, 6)}`;
    const po = await prisma.purchaseOrder.create({ data: {
      tenantId: fx.tenantId, branchId: branch(), supplierId: fx.supplierId, createdBy: fx.clerkId,
      poNumber: `PO-${randomUUID().slice(0, 8)}`, status: "issued", items: { create: { tenantId: fx.tenantId,
        productId: fx.productId, orderedQty: 72, orderedPacks: 3, unitsPerPack: 24, unitCost: "5.00", taxPercent: 0 } },
    } });
    // Packs with no units per pack and no price on the line: posting takes 24/pack and Rs 5.00
    // from the order line, so the counter must show 72 units at 5.00, not 3 units at no cost.
    const receipt = await prisma.preparedReceipt.create({ data: {
      tenantId: fx.tenantId, branchId: branch(), purchaseOrderId: po.id, status: "approved",
      executionApprovalId: randomUUID(), preparedBy: fx.clerkId, approvedBy: fx.managerId, approvedAt: new Date(),
      payload: { purchaseOrderId: po.id, receivedOn: daysFromToday(0).toISOString().slice(0, 10), lines: [
        { productId: fx.productId, batchNo, expiryDate: daysFromToday(400).toISOString().slice(0, 10), packs: 3, sellingPrice: "15.00" },
      ] },
    } });
    const detail = await details.detail(await caller(fx.ownerId), branch(), "prepared_receipt", receipt.id);
    if (detail.kind !== "prepared_receipt") throw new Error("kind");
    expect(detail.lines).toEqual([expect.objectContaining({
      batchNo, packs: 3, unitsPerPack: 24, receivedQty: 72, unitsToStock: 72, unitCost: "5.00", packCost: null,
    })]);
  });

  it("reads a transfer approved to leave, with the approved batches", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 10 });
    const transfer = await prisma.transfer.create({ data: {
      tenantId: fx.tenantId, fromBranchId: branch(), toBranchId: fx.otherBranchId,
      transferNumber: `TR-${randomUUID().slice(0, 8)}`, status: "approved", executionApprovalId: randomUUID(),
      requestedBy: fx.clerkId, approvedBy: fx.managerId, approvedAt: new Date(),
      items: { create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 4 } },
    } });
    const detail = await details.detail(await caller(fx.ownerId), branch(), "transfer_ship", transfer.id);
    if (detail.kind !== "transfer_ship") throw new Error("kind");
    const other = await prisma.branch.findFirstOrThrow({ where: { id: fx.otherBranchId } });
    expect(detail.otherBranch).toBe(other.name);
    expect(detail.lines).toEqual([expect.objectContaining({ batchId, qty: 4, receivedQty: 0, remainingQty: 4 })]);
    // The destination's counter does not see it as something to send.
    await expect(details.detail(await caller(fx.ownerId), fx.otherBranchId, "transfer_ship", transfer.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("reads an approved supplier return with its lines and unsigned notes", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 6 });
    const goodsReturn = await prisma.goodsReturn.create({ data: {
      tenantId: fx.tenantId, branchId: branch(), returnNumber: `RT-${randomUUID().slice(0, 6)}`, type: "supplier",
      status: "awaiting_logistics", supplierId: fx.supplierId, reason: "Short dated", notes: "Rep collects Friday",
      amount: "20.00", requestedBy: fx.clerkId,
      items: { create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 2, unitPrice: "10.00", disposition: "quarantine" } },
    } });
    await prisma.managementApproval.create({ data: {
      tenantId: fx.tenantId, branchId: branch(), documentType: "goods_return", documentId: goodsReturn.id,
      documentVersion: goodsReturn.approvalVersion, documentDigest: "0".repeat(64), material: {},
      requestedByUserId: fx.clerkId, authorizedAction: "goods_return.complete", approvedByUserId: fx.managerId, reason: "Approved",
    } });
    const detail = await details.detail(await caller(fx.ownerId), branch(), "supplier_return", goodsReturn.id);
    if (detail.kind !== "supplier_return") throw new Error("kind");
    expect(detail.subject).toBe("Integration Supplier");
    expect(detail.amount).toBe("20.00");
    expect(detail.lines).toEqual([expect.objectContaining({
      batchId, qty: 2, quarantined: false, disposition: "quarantine", unitPrice: "10.00",
    })]);
    expect(detail.notes).toEqual([
      { label: "Reason", text: "Short dated", by: null, at: null },
      { label: "Note", text: "Rep collects Friday", by: null, at: null },
    ]);
  });

  it("reads a stock count whose afterPost is exactly what posting leaves, with a sale after the count", async () => {
    const st = await approvedStocktake(47, 50);
    // Five units leave after the count. Decision 3 keeps them: the count's −3 applies to now.
    await prisma.$transaction((tx) => stock.issue(tx,
      { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, referenceType: "adjustment", referenceId: randomUUID() },
      [{ productId: fx.productId, batchId: st.batchId, qty: 5, movementType: StockMovementType.adjustment_out }]));

    const detail = await details.detail(await caller(fx.ownerId), branch(), "stocktake", st.id);
    if (detail.kind !== "stocktake") throw new Error("kind");
    expect(detail.lines).toEqual([expect.objectContaining({
      batchId: st.batchId, onHandAtCount: 50, countedQty: 47, difference: -3, now: 45, afterPost: 42,
    })]);
    expect(detail.totals).toMatchObject({ lines: 1, differences: 1 });
    expect(await onHand(st.batchId)).toBe(45);

    await stocktakes.post(await caller(fx.ownerId), branch(), st.id);
    expect(await onHand(st.batchId)).toBe(detail.lines[0]!.afterPost);
    // Posted: no longer waiting at the counter.
    await expect(details.detail(await caller(fx.ownerId), branch(), "stocktake", st.id))
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

  it("lists a stopped import that posted stock (status failed, batchesCreated 0), and drops it once undone", async () => {
    // A stopped run writes stock in chunks but never writes `batchesCreated`. The web hands
    // exactly this import to the counter, so the counter must list it.
    const { importId, batchId } = await importWithStock(9);
    await prisma.productImport.update({ where: { id: importId, tenantId: fx.tenantId },
      data: { status: "failed", batchesCreated: 0, unitsPosted: 0 } });
    const created = await prisma.product.create({ data: { tenantId: fx.tenantId, sku: `IMP-${randomUUID().slice(0, 6)}`,
      name: "Imported only, no stock", importId } });

    const listed = (await details.undoableImports(await caller(fx.ownerId), branch())).find((i) => i.importId === importId)!;
    expect(listed).toMatchObject({
      stopped: true, batches: 1, units: 9,
      lines: [expect.objectContaining({ batchId, qty: 9 })],
      createdProducts: [{ productId: created.id, productName: "Imported only, no stock" }],
    });
    // The web agrees: it routes this import's undo to the counter.
    const web = (await imports.listImports(fx.tenantId, 50, branch())).find((i) => i.id === importId)!;
    expect(web.stockUndo).toBe(true);

    await imports.undo(fx.tenantId, fx.ownerId, importId, true, branch(), async () => undefined);
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
