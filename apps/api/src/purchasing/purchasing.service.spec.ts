import { BadRequestException } from "@nestjs/common";
import { PoStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PurchasingService } from "./purchasing.service";

describe("PurchasingService", () => {
  let prisma: Record<string, unknown>;
  let audit: AuditService;
  let service: PurchasingService;

  beforeEach(() => {
    prisma = {
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      purchaseOrder: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      goodsReceipt: { count: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
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
    service = new PurchasingService(prisma as never, audit);
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
    (prisma.purchaseOrder as { update: jest.Mock }).update.mockResolvedValue({
      id: "po-1",
      status: PoStatus.cancelled,
    });

    const res = await service.cancelPurchaseOrder("t1", "b1", "u1", "po-1");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(PoStatus.cancelled);
    expect(audit.log as jest.Mock).toHaveBeenCalled();
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

    const res = await service.receiveGoods("t1", "b1", "u1", dto, "idem-key-1");
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

    await expect(service.receiveGoods("t1", "b1", "u1", dto, "idem-key-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
