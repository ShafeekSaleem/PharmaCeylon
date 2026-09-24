import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PoStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import type { ActorAccess } from "../security/access.service";
import { PurchasingService } from "./purchasing.service";

function approver(userId: string, canSelfApprove = false): ActorAccess {
  return {
    userId,
    permissions: new Set(["purchasing.approve"]),
    roleKeys: ["inventory_clerk"],
    canSelfApprove,
    has: (key) => key === "purchasing.approve",
  };
}

describe("PurchasingService", () => {
  let prisma: Record<string, unknown>;
  let audit: AuditService;
  let service: PurchasingService;
  const access = {
    userId: "u1",
    permissions: new Set(["purchasing.receive"]),
    roleKeys: ["inventory_clerk"],
    canSelfApprove: false,
    has: (key: string) => key === "purchasing.receive",
  } as unknown as ActorAccess;

  beforeEach(() => {
    prisma = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      purchaseOrder: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      goodsReceipt: { count: jest.fn(), findFirst: jest.fn() },
      batch: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          $queryRaw: jest.fn().mockResolvedValue([{ id: "po-1" }]),
          documentSequence: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
            update: jest.fn(),
          },
          purchaseOrder: prisma.purchaseOrder,
          goodsReceipt: {
            ...(prisma.goodsReceipt as object),
            create: jest.fn().mockResolvedValue({ id: "gr-new" }),
            findMany: jest.fn().mockResolvedValue([]),
          },
          goodsReceiptItem: { create: jest.fn() },
          batch: { create: jest.fn().mockResolvedValue({ id: "batch-1" }) },
          stockLedger: { create: jest.fn() },
          idempotencyRecord: { create: jest.fn() },
        };
        return fn(tx);
      }),
    };
    audit = { log: jest.fn() } as unknown as AuditService;
    service = new PurchasingService(prisma as never, audit, {} as never, {} as never);
  });

  it("cancelPurchaseOrder rejects when PO already has receipts (partial)", async () => {
    (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      id: "po-1",
      tenantId: "t1",
      branchId: "b1",
      status: PoStatus.partially_received,
      items: [],
      supplier: {},
      goodsReceipts: [{ id: "gr-1" }],
    });

    await expect(service.cancelPurchaseOrder("t1", "b1", "u1", "po-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("cancelPurchaseOrder succeeds for issued PO without receipts", async () => {
    (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      id: "po-1",
      tenantId: "t1",
      branchId: "b1",
      status: PoStatus.issued,
      items: [],
      supplier: {},
      goodsReceipts: [],
    });
    (prisma.purchaseOrder as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 1,
      id: "po-1",
      status: PoStatus.cancelled,
    });

    const res = await service.cancelPurchaseOrder("t1", "b1", "u1", "po-1");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(PoStatus.cancelled);
    expect(audit.log as jest.Mock).toHaveBeenCalled();
  });

  it("cancelPurchaseOrder rejects when PO is short-closed", async () => {
    (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      id: "po-1",
      tenantId: "t1",
      branchId: "b1",
      status: PoStatus.short_closed,
      items: [],
      supplier: {},
      goodsReceipts: [{ id: "gr-1" }],
    });

    await expect(service.cancelPurchaseOrder("t1", "b1", "u1", "po-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("issuePurchaseOrder rejects pending_approval", async () => {
    (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      id: "po-1",
      tenantId: "t1",
      branchId: "b1",
      status: PoStatus.pending_approval,
      items: [],
      supplier: {},
      goodsReceipts: [],
    });

    await expect(service.issuePurchaseOrder("t1", "b1", "u1", "po-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("approvePurchaseOrder issues pending_approval PO", async () => {
    (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      id: "po-1",
      tenantId: "t1",
      branchId: "b1",
      status: PoStatus.pending_approval,
      items: [],
      supplier: {},
      goodsReceipts: [],
    });
    (prisma.purchaseOrder as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 1,
      id: "po-1",
      status: PoStatus.issued,
    });

    const res = await service.approvePurchaseOrder("t1", "b1", approver("u2"), "po-1");
    expect(res!.status).toBe(PoStatus.issued);
    expect((prisma.purchaseOrder as { updateMany: jest.Mock }).updateMany).toHaveBeenCalledWith({
      // The status is part of the write, so a cancel landing first leaves nothing to approve.
      where: {
        id: "po-1",
        tenantId: "t1",
        branchId: "b1",
        status: { in: [PoStatus.pending_approval] },
      },
      data: { status: PoStatus.issued },
    });
    expect(audit.log as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "purchase_order.approved" }),
    );
  });

  describe("self-approval", () => {
    const pending = {
      id: "po-1",
      tenantId: "t1",
      branchId: "b1",
      status: PoStatus.pending_approval,
      createdBy: "u1",
      items: [],
      supplier: {},
      goodsReceipts: [],
    };

    it("refuses an approver whose role may not approve their own order", async () => {
      (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue(pending);
      await expect(
        service.approvePurchaseOrder("t1", "b1", approver("u1", false), "po-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((prisma.purchaseOrder as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled();
    });

    it("lets a role in the self-approval list approve its own order, and records that it did", async () => {
      (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue(pending);
      await service.approvePurchaseOrder("t1", "b1", approver("u1", true), "po-1");
      expect(audit.log as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "purchase_order.approved",
          payload: { selfApproved: true },
        }),
      );
    });

    it("refuses to approve an order that stopped waiting for approval meanwhile", async () => {
      (prisma.purchaseOrder as { findFirst: jest.Mock }).findFirst.mockResolvedValue(pending);
      (prisma.purchaseOrder as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 0 });
      (prisma.purchaseOrder as { count: jest.Mock }).count.mockResolvedValue(1);
      await expect(
        service.approvePurchaseOrder("t1", "b1", approver("u2"), "po-1"),
      ).rejects.toThrow(/no longer waiting for approval/);
      expect(audit.log as jest.Mock).not.toHaveBeenCalled();
    });
  });

  it("receiveGoods returns replay when idempotency key already committed", async () => {
    (prisma.idempotencyRecord as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      resourceId: "gr-replay",
    });
    (prisma.goodsReceipt as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      id: "gr-replay",
      purchaseOrderId: "00000000-0000-0000-0000-000000000001",
      items: [],
    });

    const dto = {
      purchaseOrderId: "00000000-0000-0000-0000-000000000001",
      receivedOn: "2026-01-15",
      lines: [
        {
          productId: "00000000-0000-0000-0000-000000000002",
          batchNo: "B1",
          expiryDate: "2027-01-01",
          receivedQty: 1,
          costPrice: "10.00",
          sellingPrice: "12.00",
        },
      ],
    };

    const res = await service.receiveGoods("t1", "b1", "u1", access, dto, "idem-key-1");
    expect(res).toEqual({
      id: "gr-replay",
      purchaseOrderId: "00000000-0000-0000-0000-000000000001",
      items: [],
    });
    expect(prisma.$transaction as jest.Mock).not.toHaveBeenCalled();
  });

  it("receiveGoods rejects idempotency replay when PO differs", async () => {
    (prisma.idempotencyRecord as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      resourceId: "gr-replay",
    });
    (prisma.goodsReceipt as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      id: "gr-replay",
      purchaseOrderId: "00000000-0000-0000-0000-000000000099",
      items: [],
    });

    const dto = {
      purchaseOrderId: "00000000-0000-0000-0000-000000000001",
      receivedOn: "2026-01-15",
      lines: [
        {
          productId: "00000000-0000-0000-0000-000000000002",
          batchNo: "B1",
          expiryDate: "2027-01-01",
          receivedQty: 1,
          costPrice: "10.00",
          sellingPrice: "12.00",
        },
      ],
    };

    await expect(service.receiveGoods("t1", "b1", "u1", access, dto, "idem-key-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
