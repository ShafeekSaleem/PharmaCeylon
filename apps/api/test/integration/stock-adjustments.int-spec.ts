import { randomUUID } from "node:crypto";
import { AuditService } from "../../src/audit/audit.service";
import { AdjustmentService } from "../../src/inventory/adjustment.service";
import { InventoryService } from "../../src/inventory/inventory.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { AccessService } from "../../src/security/access.service";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import {
  batchTotals,
  createPrisma,
  createStockedBatch,
  createTenant,
  type TenantFixture,
} from "./fixtures";

/** `POST /inventory/adjustments` with an Idempotency-Key, against real row and advisory locks. */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const stock = new StockService();
const access = new AccessService(prisma as never, {} as never);
const notifications = {
  notifyByPermission: jest.fn().mockResolvedValue(1),
  notifyUser: jest.fn(),
};
const adjustments = new AdjustmentService(
  prisma as never,
  new InventoryService(prisma as never, audit, stock, new StockReadService(prisma as never)),
  notifications as never,
  audit,
  access,
  new ManagementApprovalsService(access, audit),
);
let fx: TenantFixture;
const user = (id: string): RequestUser => ({
  tenantId: fx.tenantId,
  userId: id,
  tokenVersion: 0,
  branchRoles: [],
  email: "adjust@it.test",
  fullName: "Adjust actor",
  authMethod: "cookie",
});
const movements = (batchId: string) =>
  prisma.stockLedger.findMany({
    where: { tenantId: fx.tenantId, batchId, movementType: { in: ["adjustment_in", "adjustment_out"] } },
  });
const adjustmentAudits = (referenceId: string) =>
  prisma.auditEvent.count({
    where: {
      tenantId: fx.tenantId,
      eventName: "inventory.adjustment",
      payload: { path: ["referenceId"], equals: referenceId },
    },
  });
const keyRecords = (userId: string, scope: string, idempotencyKey: string) =>
  prisma.idempotencyRecord.findMany({ where: { tenantId: fx.tenantId, userId, scope, idempotencyKey } });

beforeAll(async () => {
  fx = await createTenant(prisma, "stock-adjustments");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "inventory_clerk" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
    ],
  });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("direct stock adjustments with an Idempotency-Key", () => {
  it("moves stock once for two identical write-offs sent at once, and replays it later", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
    const key = `adjustment-${randomUUID()}`;
    const body = { productId: fx.productId, batchId, qty: 3, kind: "lost" as const, reason: "Missing during count" };
    const [first, second] = await Promise.all([
      adjustments.postDirect(user(fx.managerId), fx.mainBranchId, { ...body }, key),
      adjustments.postDirect(user(fx.managerId), fx.mainBranchId, { ...body }, key),
    ]);
    expect(first).toEqual({ held: false, ok: true, referenceId: expect.any(String), batchId });
    expect(second).toEqual(first);
    expect((await batchTotals(prisma, batchId)).onHand).toBe(17);
    expect((await movements(batchId)).map((row) => row.referenceId)).toEqual([first.referenceId]);
    expect(await adjustmentAudits(first.referenceId)).toBe(1);
    const [record, ...more] = await keyRecords(fx.managerId, "stock_adjustment", key);
    expect(more).toHaveLength(0);
    expect(record).toMatchObject({ resourceId: first.referenceId, requestBody: body });

    // The reply was lost; the same save goes again.
    await expect(adjustments.postDirect(user(fx.managerId), fx.mainBranchId, { ...body }, key)).resolves.toEqual(first);
    expect((await batchTotals(prisma, batchId)).onHand).toBe(17);
    expect(await movements(batchId)).toHaveLength(1);
  });

  it("returns the batch a keyed increase opened to its resend, and opens it once", async () => {
    const batchNo = `N-${randomUUID().slice(0, 6)}`;
    const key = `adjustment-${randomUUID()}`;
    const body = {
      productId: fx.productId,
      qty: 12,
      kind: "opening" as const,
      newBatch: { batchNo, expiryDate: "2030-06-30", costPrice: 12.5, sellingPrice: 15 },
    };
    const [first, second] = await Promise.all([
      adjustments.postDirect(user(fx.managerId), fx.mainBranchId, structuredClone(body), key),
      adjustments.postDirect(user(fx.managerId), fx.mainBranchId, structuredClone(body), key),
    ]);
    expect(second).toEqual(first);
    const batches = await prisma.batch.findMany({ where: { tenantId: fx.tenantId, branchId: fx.mainBranchId, batchNo } });
    expect(batches.map((batch) => batch.id)).toEqual([first.batchId]);
    expect((await batchTotals(prisma, first.batchId)).onHand).toBe(12);
  });

  it("refuses the key for a different adjustment, or at another branch, and moves nothing for it", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
    const key = `adjustment-${randomUUID()}`;
    const body = { productId: fx.productId, batchId, qty: 2, kind: "found" as const };
    await adjustments.postDirect(user(fx.managerId), fx.mainBranchId, body, key);
    await expect(
      adjustments.postDirect(user(fx.managerId), fx.mainBranchId, { ...body, qty: 4 }, key),
    ).rejects.toThrow("Idempotency-Key already used for a different stock adjustment");
    await expect(
      adjustments.postDirect(user(fx.managerId), fx.otherBranchId, body, key),
    ).rejects.toThrow("Idempotency-Key already used for a different stock adjustment");
    expect((await batchTotals(prisma, batchId)).onHand).toBe(22);
    expect(await movements(batchId)).toHaveLength(1);
  });

  it("keeps a refused write-off's key unused, and its held request under its own key holds it once", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 8 });
    const directKey = `adjustment-${randomUUID()}`;
    const requestKey = `write-off-${randomUUID()}`;
    const body = { productId: fx.productId, batchId, qty: 2, kind: "lost" as const, reason: "Missing" };
    // What the web modal does on Save, twice: the second after the request's reply was lost.
    const save = async () => {
      const refusal = await adjustments
        .postDirect(user(fx.clerkId), fx.mainBranchId, { ...body }, directKey)
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({ response: { code: "WRITE_OFF_APPROVAL_REQUIRED" } });
      return adjustments.request(user(fx.clerkId), fx.mainBranchId, { ...body }, requestKey);
    };
    const first = await save();
    const second = await save();
    expect(second.heldAdjustment.id).toBe(first.heldAdjustment.id);
    expect(second.notified).toBe(0);
    expect(await keyRecords(fx.clerkId, "stock_adjustment", directKey)).toHaveLength(0);
    expect(await keyRecords(fx.clerkId, "held_adjustment_request", requestKey)).toHaveLength(1);
    expect(await prisma.heldAdjustment.count({ where: { tenantId: fx.tenantId, batchId } })).toBe(1);
    expect((await batchTotals(prisma, batchId)).onHand).toBe(8);
    expect(await movements(batchId)).toHaveLength(0);
  });

  it("keeps keys per person, and posts every request sent without one", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
    const key = `adjustment-${randomUUID()}`;
    const body = { productId: fx.productId, batchId, qty: 1, kind: "found" as const };
    const manager = await adjustments.postDirect(user(fx.managerId), fx.mainBranchId, body, key);
    const clerk = await adjustments.postDirect(user(fx.clerkId), fx.mainBranchId, body, key);
    expect(clerk.referenceId).not.toBe(manager.referenceId);
    await Promise.all([
      adjustments.postDirect(user(fx.managerId), fx.mainBranchId, body),
      adjustments.postDirect(user(fx.managerId), fx.mainBranchId, body),
    ]);
    expect((await batchTotals(prisma, batchId)).onHand).toBe(24);
    expect(await movements(batchId)).toHaveLength(4);
  });
});
