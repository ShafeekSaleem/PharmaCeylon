import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { AdjustmentService } from "./adjustment.service";
import type { StockAdjustmentDto } from "./dto/stock-adjustment.dto";

const user: RequestUser = {
  tenantId: "tenant-1",
  userId: "clerk-1",
  tokenVersion: 0,
  branchRoles: [],
  email: "clerk@test",
  fullName: "Clerk",
  authMethod: "cookie",
};
const BRANCH = "branch-1";
const KEY = "write-off-7d1f";
const dto = (fields: Partial<StockAdjustmentDto> = {}) =>
  ({
    productId: "product-1",
    batchId: "batch-1",
    qty: 2,
    kind: "lost",
    reason: "Missing",
    ...fields,
  }) as StockAdjustmentDto;
const stored = (fields: Partial<StockAdjustmentDto> = {}) => ({
  ...JSON.parse(JSON.stringify(dto(fields))),
  movementType: "adjustment_out",
});

function heldRow(id: string, payload: unknown, branchId = BRANCH) {
  return {
    id,
    tenantId: user.tenantId,
    branchId,
    productId: "product-1",
    batchId: "batch-1",
    kind: "lost",
    qty: 2,
    value: new Prisma.Decimal("20.00"),
    note: "Missing",
    payload,
    status: "pending",
    approvalVersion: 1,
    referenceId: null,
    executionApprovalId: null,
    executedBy: null,
    executedAt: null,
    requestedBy: user.userId,
    requestedAt: new Date("2026-11-04T08:00:00Z"),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    product: { id: "product-1", sku: "P1", name: "Paracetamol" },
    batch: {
      id: "batch-1",
      batchNo: "B1",
      expiryDate: new Date("2027-01-01T00:00:00Z"),
    },
    requester: { id: user.userId, fullName: "Clerk" },
    decider: null,
  };
}

function setup() {
  let created = 0;
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    batch: {
      findFirst: jest
        .fn()
        .mockResolvedValue({
          id: "batch-1",
          costPrice: new Prisma.Decimal("10.00"),
        }),
    },
    heldAdjustment: {
      create: jest.fn(
        async ({ data }: { data: { payload: unknown; branchId: string } }) =>
          heldRow(`held-${++created}`, data.payload, data.branchId),
      ),
    },
  };
  const prisma = {
    idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    heldAdjustment: { findFirst: jest.fn() },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const actor = { has: jest.fn().mockReturnValue(true) };
  const access = { resolveLive: jest.fn().mockResolvedValue(actor) };
  const notifications = { notifyByPermission: jest.fn().mockResolvedValue(2) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new AdjustmentService(
    prisma as never,
    {} as never,
    notifications as never,
    audit as never,
    access as never,
    {} as never,
  );
  /** The key as an earlier request recorded it, pointing at `row`. */
  const recorded = (row: ReturnType<typeof heldRow>) => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue({
      resourceId: row.id,
    });
    prisma.heldAdjustment.findFirst.mockResolvedValue(row);
  };
  return { service, prisma, tx, notifications, recorded };
}

describe("held write-off requests and Idempotency-Key", () => {
  it("holds a new write-off on every request sent without a key, as before", async () => {
    const { service, tx, prisma } = setup();
    const first = await service.request(user, BRANCH, dto());
    const second = await service.request(user, BRANCH, dto());
    expect(first.heldAdjustment.id).not.toBe(second.heldAdjustment.id);
    expect(tx.heldAdjustment.create).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.idempotencyRecord.create).not.toHaveBeenCalled();
    expect(prisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
  });

  it("records the key against the held adjustment, under the request's lock", async () => {
    const { service, tx, notifications } = setup();
    const result = await service.request(user, BRANCH, dto(), `  ${KEY}  `);
    expect(result).toMatchObject({
      held: true,
      notified: 2,
      heldAdjustment: { id: "held-1" },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]).toContain(
      `held_adjustment_request:tenant-1:clerk-1:${KEY}`,
    );
    expect(tx.idempotencyRecord.create).toHaveBeenCalledWith({
      data: {
        tenantId: "tenant-1",
        userId: "clerk-1",
        scope: "held_adjustment_request",
        idempotencyKey: KEY,
        resourceId: "held-1",
      },
    });
    expect(notifications.notifyByPermission).toHaveBeenCalledTimes(1);
  });

  it("returns the first request's held adjustment to a resend, holding and notifying nothing", async () => {
    const { service, prisma, tx, notifications, recorded } = setup();
    // jsonb hands the payload back with its keys reordered.
    const { reason, ...rest } = stored();
    recorded(heldRow("held-original", { reason, ...rest }));
    const result = await service.request(user, BRANCH, dto(), KEY);
    expect(result).toMatchObject({
      held: true,
      notified: 0,
      heldAdjustment: { id: "held-original", qty: 2 },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.heldAdjustment.create).not.toHaveBeenCalled();
    expect(notifications.notifyByPermission).not.toHaveBeenCalled();
  });

  it("refuses the key for a different write-off, or the same one at another branch", async () => {
    for (const [row, body] of [
      [heldRow("held-original", stored()), dto({ qty: 3 })],
      [heldRow("held-original", stored()), dto({ reason: "Broken" })],
      [heldRow("held-original", stored()), dto({ kind: "damaged" })],
      [heldRow("held-original", stored(), "branch-2"), dto()],
    ] as const) {
      const { service, prisma, recorded } = setup();
      recorded(row);
      await expect(service.request(user, BRANCH, body, KEY)).rejects.toThrow(
        new BadRequestException(
          "Idempotency-Key already used for a different write-off request",
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it("replays when the key committed while this request waited on its lock", async () => {
    const { service, prisma, tx, notifications } = setup();
    tx.idempotencyRecord.findUnique.mockResolvedValueOnce({
      resourceId: "held-original",
    });
    prisma.idempotencyRecord.findUnique
      .mockResolvedValueOnce(null) // before the transaction: not yet committed
      .mockResolvedValueOnce({ resourceId: "held-original" });
    prisma.heldAdjustment.findFirst.mockResolvedValue(
      heldRow("held-original", stored()),
    );
    const result = await service.request(user, BRANCH, dto(), KEY);
    expect(result.heldAdjustment.id).toBe("held-original");
    expect(tx.heldAdjustment.create).not.toHaveBeenCalled();
    expect(notifications.notifyByPermission).not.toHaveBeenCalled();
  });

  it("replays when the key's unique row is what stopped this request", async () => {
    const { service, prisma, tx } = setup();
    tx.idempotencyRecord.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["tenant_id", "user_id", "scope", "idempotency_key"] },
      }),
    );
    prisma.idempotencyRecord.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ resourceId: "held-original" });
    prisma.heldAdjustment.findFirst.mockResolvedValue(
      heldRow("held-original", stored()),
    );
    await expect(
      service.request(user, BRANCH, dto(), KEY),
    ).resolves.toMatchObject({
      notified: 0,
      heldAdjustment: { id: "held-original" },
    });
  });

  it("refuses a key longer than 128 characters before anything else", async () => {
    const { service, prisma } = setup();
    await expect(
      service.request(user, BRANCH, dto(), "k".repeat(129)),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
