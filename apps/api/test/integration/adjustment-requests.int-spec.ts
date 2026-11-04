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

/** `POST /inventory/adjustment-requests` with an Idempotency-Key, against real row locks. */
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
  new InventoryService(
    prisma as never,
    audit,
    stock,
    new StockReadService(prisma as never),
  ),
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
const heldFor = (batchId: string) =>
  prisma.heldAdjustment.findMany({ where: { tenantId: fx.tenantId, batchId } });
const heldAudits = (ids: string[]) =>
  prisma.auditEvent.count({
    where: {
      tenantId: fx.tenantId,
      eventName: "inventory.write_off_held",
      OR: ids.map((id) => ({
        payload: { path: ["heldAdjustmentId"], equals: id },
      })),
    },
  });

beforeAll(async () => {
  fx = await createTenant(prisma, "adjustment-requests");
  await prisma.userBranchRole.createMany({
    data: [
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.clerkId,
        role: "inventory_clerk",
      },
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.managerId,
        role: "manager",
      },
    ],
  });
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(() => notifications.notifyByPermission.mockClear());

describe("held write-off requests with an Idempotency-Key", () => {
  it("holds one write-off for two identical requests sent at once, and replays it later", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
    const key = randomUUID();
    const body = {
      productId: fx.productId,
      batchId,
      qty: 2,
      kind: "lost" as const,
      reason: "Missing during count",
    };
    const [first, second] = await Promise.all([
      adjustments.request(user(fx.clerkId), fx.mainBranchId, { ...body }, key),
      adjustments.request(user(fx.clerkId), fx.mainBranchId, { ...body }, key),
    ]);
    expect(second.heldAdjustment.id).toBe(first.heldAdjustment.id);
    const held = await heldFor(batchId);
    expect(held.map((row) => row.id)).toEqual([first.heldAdjustment.id]);
    expect(await heldAudits([first.heldAdjustment.id])).toBe(1);
    expect(notifications.notifyByPermission).toHaveBeenCalledTimes(1);
    expect([first.notified, second.notified].sort()).toEqual([0, 1]);

    const resent = await adjustments.request(
      user(fx.clerkId),
      fx.mainBranchId,
      { ...body },
      key,
    );
    expect(resent).toMatchObject({
      held: true,
      notified: 0,
      heldAdjustment: { id: first.heldAdjustment.id },
    });
    expect(await heldFor(batchId)).toHaveLength(1);
    expect((await batchTotals(prisma, batchId)).onHand).toBe(20);
  });

  it("refuses the key for a different write-off and holds nothing for it", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
    const key = randomUUID();
    const body = {
      productId: fx.productId,
      batchId,
      qty: 2,
      kind: "lost" as const,
      reason: "Missing",
    };
    await adjustments.request(user(fx.clerkId), fx.mainBranchId, body, key);
    await expect(
      adjustments.request(
        user(fx.clerkId),
        fx.mainBranchId,
        { ...body, qty: 3 },
        key,
      ),
    ).rejects.toThrow(
      "Idempotency-Key already used for a different write-off request",
    );
    expect(await heldFor(batchId)).toHaveLength(1);
  });

  it("keeps keys per person, and holds every request sent without one", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
    const key = randomUUID();
    const body = {
      productId: fx.productId,
      batchId,
      qty: 1,
      kind: "damaged" as const,
      reason: "Dropped",
    };
    const clerk = await adjustments.request(
      user(fx.clerkId),
      fx.mainBranchId,
      body,
      key,
    );
    const manager = await adjustments.request(
      user(fx.managerId),
      fx.mainBranchId,
      body,
      key,
    );
    expect(manager.heldAdjustment.id).not.toBe(clerk.heldAdjustment.id);
    await Promise.all([
      adjustments.request(user(fx.clerkId), fx.mainBranchId, body),
      adjustments.request(user(fx.clerkId), fx.mainBranchId, body),
    ]);
    expect(await heldFor(batchId)).toHaveLength(4);
  });
});
