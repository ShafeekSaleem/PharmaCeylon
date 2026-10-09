import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  GoodsReturnStatus,
  PaymentMethod,
  Prisma,
  SaleStatus,
  StockMovementType,
} from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { TaxService } from "../pricing/tax.service";
import { SalesService } from "./sales.service";

describe("SalesService.refundSale", () => {
  const tenantId = "t1";
  const branchId = "b1";
  const userId = "u1";
  const saleId = "sale-1";
  const productId = "p1";
  const batchId = "batch-1";

  let prisma: Record<string, unknown>;
  let audit: AuditService;
  let tax: TaxService;
  let service: SalesService;
  let stock: { receive: jest.Mock; issue: jest.Mock; quarantine: jest.Mock };
  let pharmacistApproval: { verifyApproverPin: jest.Mock; hasApproverRole: jest.Mock };
  let txState: {
    goodsReturnCreate: jest.Mock;
    stockLedgerCreate: jest.Mock;
    salePaymentCreate: jest.Mock;
    saleUpdate: jest.Mock;
    completedReturns: { items: { productId: string; batchId: string; qty: number }[] }[];
    threshold: string | null;
  };

  beforeEach(() => {
    stock = { receive: jest.fn(), issue: jest.fn(), quarantine: jest.fn() };
    txState = {
      goodsReturnCreate: jest.fn().mockResolvedValue({
        id: "gr-1",
        returnNumber: "RET-2026-00001",
      }),
      stockLedgerCreate: jest.fn(),
      salePaymentCreate: jest.fn(),
      saleUpdate: jest.fn(),
      completedReturns: [],
      threshold: null,
    };

    const saleRow = {
      id: saleId,
      invoiceNo: "INV-2607-000001",
      status: SaleStatus.posted,
      prescriptionId: null as string | null,
      customer: { fullName: "Walk-in" },
      items: [
        {
          id: "si-1",
          productId,
          batchId,
          qty: 4,
          unitPrice: new Prisma.Decimal("10.00"),
          lineTotal: new Prisma.Decimal("40.00"),
          product: { id: productId, isControlled: false, name: "Para" },
          batch: { id: batchId, batchNo: "B1" },
        },
      ],
    };

    prisma = {
      sale: {
        findFirst: jest.fn().mockResolvedValue({
          ...saleRow,
          items: saleRow.items,
          payments: [],
          customer: saleRow.customer,
          prescription: null,
          seller: { id: userId, fullName: "Cashier" },
        }),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          sale: {
            findFirst: jest.fn().mockResolvedValue(saleRow),
            update: txState.saleUpdate,
          },
          goodsReturn: {
            count: jest.fn().mockResolvedValue(0),
            create: txState.goodsReturnCreate,
            findMany: jest.fn().mockImplementation(({ where }: { where: { status: unknown } }) => {
              if (where.status === GoodsReturnStatus.completed) {
                return Promise.resolve(txState.completedReturns);
              }
              return Promise.resolve([]);
            }),
          },
          stockLedger: {
            create: txState.stockLedgerCreate,
            groupBy: jest.fn().mockResolvedValue([]),
          },
          salePayment: {
            create: txState.salePaymentCreate,
          },
          tenantSettings: {
            findUnique: jest.fn().mockImplementation(() =>
              Promise.resolve(
                txState.threshold
                  ? { approvalRequiredReturnThreshold: new Prisma.Decimal(txState.threshold) }
                  : null,
              ),
            ),
          },
        };
        return fn(tx);
      }),
    };

    audit = { log: jest.fn() } as unknown as AuditService;
    tax = { getVatRatePercent: () => 0 } as unknown as TaxService;
    pharmacistApproval = {
      verifyApproverPin: jest.fn(),
      hasApproverRole: jest.fn().mockReturnValue(false),
    };
    service = new SalesService(
      prisma as never,
      audit,
      tax,
      pharmacistApproval as never,
      { assertCanSell: jest.fn().mockResolvedValue(undefined) } as never,
      stock as never,
    );
  });

  const access = (permissions: string[], canSelfApprove = false) => ({
    userId,
    permissions: new Set(permissions),
    roleKeys: [],
    canSelfApprove,
    has: (key: string) => permissions.includes(key),
  });
  const cashierRoles = access(["sales.pos_use", "sales.refund"]);
  const pharmacistRoles = access(["sales.pos_use", "sales.refund", "sales.approve_controlled"]);

  it("creates completed GoodsReturn, customer_return_in, and negative payment", async () => {
    await service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, {
      reason: "Customer changed mind",
      refundMethod: PaymentMethod.cash,
    });

    expect(txState.goodsReturnCreate).toHaveBeenCalled();
    const grData = txState.goodsReturnCreate.mock.calls[0][0].data;
    expect(grData.status).toBe(GoodsReturnStatus.completed);
    expect(grData.saleId).toBe(saleId);

    // Returned units go back through the stock service, like every other stock change.
    expect(stock.receive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ referenceType: "goods_return", referenceId: "gr-1" }),
      [
        expect.objectContaining({
          movementType: StockMovementType.customer_return_in,
          batchId,
          qty: 4,
        }),
      ],
    );

    expect(txState.salePaymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          method: PaymentMethod.cash,
          amount: expect.anything(),
        }),
      }),
    );
    const payAmount = txState.salePaymentCreate.mock.calls[0][0].data.amount as Prisma.Decimal;
    expect(payAmount.isNegative()).toBe(true);

    expect(txState.saleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: saleId, tenantId, branchId },
        data: { status: SaleStatus.refunded },
      }),
    );
  });

  it("partial refund sets partially_refunded when qty remains", async () => {
    // After creating GR for qty 1, second getSaleReturnableByLine sees completedReturns with qty 1
    let findManyCalls = 0;
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          sale: {
            findFirst: jest.fn().mockResolvedValue({
              id: saleId,
              invoiceNo: "INV-2607-000001",
              status: SaleStatus.posted,
              prescriptionId: null,
              customer: { fullName: "Walk-in" },
              items: [
                {
                  id: "si-1",
                  productId,
                  batchId,
                  qty: 4,
                  unitPrice: new Prisma.Decimal("10.00"),
                  lineTotal: new Prisma.Decimal("40.00"),
                  product: { id: productId, isControlled: false, name: "Para" },
                },
              ],
            }),
            update: txState.saleUpdate,
          },
          goodsReturn: {
            count: jest.fn().mockResolvedValue(0),
            create: txState.goodsReturnCreate,
            findMany: jest.fn().mockImplementation(() => {
              findManyCalls += 1;
              // After create, status resolution call should see the new return.
              // Calls: first pair (completed+open) before create, second pair after.
              if (findManyCalls > 2) {
                return Promise.resolve([{ items: [{ productId, batchId, qty: 1 }] }]);
              }
              return Promise.resolve([]);
            }),
          },
          stockLedger: {
            create: txState.stockLedgerCreate,
            groupBy: jest.fn().mockResolvedValue([]),
          },
          salePayment: { create: txState.salePaymentCreate },
          tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        return fn(tx);
      },
    );

    await service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, {
      reason: "One unit only",
      items: [{ productId, batchId, qty: 1 }],
    });

    expect(txState.saleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: saleId, tenantId, branchId },
        data: { status: SaleStatus.partially_refunded },
      }),
    );
  });

  it("blocks cashier on controlled sale", async () => {
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          sale: {
            findFirst: jest.fn().mockResolvedValue({
              id: saleId,
              invoiceNo: "INV-1",
              status: SaleStatus.posted,
              prescriptionId: null,
              customer: null,
              items: [
                {
                  productId,
                  batchId,
                  qty: 1,
                  unitPrice: new Prisma.Decimal("50"),
                  lineTotal: new Prisma.Decimal("50"),
                  product: { id: productId, isControlled: true, name: "Ctrl" },
                },
              ],
            }),
            update: txState.saleUpdate,
          },
          goodsReturn: {
            count: jest.fn(),
            create: txState.goodsReturnCreate,
            findMany: jest.fn().mockResolvedValue([]),
          },
          stockLedger: {
            create: txState.stockLedgerCreate,
            groupBy: jest.fn().mockResolvedValue([]),
          },
          salePayment: { create: txState.salePaymentCreate },
          tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        return fn(tx);
      },
    );

    await expect(
      service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, {
        reason: "Need refund",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows pharmacist on controlled sale", async () => {
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          sale: {
            findFirst: jest.fn().mockResolvedValue({
              id: saleId,
              invoiceNo: "INV-1",
              status: SaleStatus.posted,
              prescriptionId: "rx-1",
              customer: null,
              items: [
                {
                  productId,
                  batchId,
                  qty: 1,
                  unitPrice: new Prisma.Decimal("50"),
                  lineTotal: new Prisma.Decimal("50"),
                  product: { id: productId, isControlled: true, name: "Ctrl" },
                },
              ],
            }),
            update: txState.saleUpdate,
          },
          goodsReturn: {
            count: jest.fn().mockResolvedValue(0),
            create: txState.goodsReturnCreate,
            findMany: jest.fn().mockResolvedValue([]),
          },
          stockLedger: {
            create: txState.stockLedgerCreate,
            groupBy: jest.fn().mockResolvedValue([]),
          },
          salePayment: { create: txState.salePaymentCreate },
          tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        return fn(tx);
      },
    );

    await service.refundSale(tenantId, branchId, userId, pharmacistRoles, saleId, {
      reason: "Pharmacist approved",
    });
    expect(txState.goodsReturnCreate).toHaveBeenCalled();
  });

  it("refuses someone without the refund permission", async () => {
    await expect(
      service.refundSale(tenantId, branchId, userId, access(["sales.pos_use"]), saleId, {
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("holds a returned item for inspection when asked, after booking it back in", async () => {
    await service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, {
      reason: "Opened box",
      items: [{ productId, batchId, qty: 2, disposition: "quarantine" }],
    });
    const item = txState.goodsReturnCreate.mock.calls[0][0].data.items.create[0];
    expect(item.disposition).toBe("quarantine");
    expect(stock.receive).toHaveBeenCalled();
    expect(stock.quarantine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ referenceType: "goods_return", referenceId: "gr-1" }),
      [expect.objectContaining({ batchId, qty: 2, reasonCode: "inspection" })],
    );
  });

  it("puts an ordinary item back on the shelf by default", async () => {
    await service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, { reason: "x" });
    const item = txState.goodsReturnCreate.mock.calls[0][0].data.items.create[0];
    expect(item.disposition).toBe("restock");
    expect(stock.quarantine).not.toHaveBeenCalled();
  });

  it("asks for an approver when the refund is over the tenant's threshold", async () => {
    txState.threshold = "20.00";
    await expect(
      service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, { reason: "x" }),
    ).rejects.toMatchObject({ response: { code: "REFUND_APPROVAL_REQUIRED" } });
    expect(txState.goodsReturnCreate).not.toHaveBeenCalled();
  });

  it("takes an approver's PIN for a refund over the threshold, and records who approved", async () => {
    txState.threshold = "20.00";
    pharmacistApproval.verifyApproverPin.mockResolvedValue({
      approverUserId: "u-manager",
      approverName: "Manager",
    });
    await service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, {
      reason: "x",
      approval: { approverUserId: "u-manager", pin: "1234" },
    });
    expect(pharmacistApproval.verifyApproverPin).toHaveBeenCalledWith(
      tenantId,
      branchId,
      "u-manager",
      "1234",
      userId,
      "returns.approve",
    );
    expect(txState.goodsReturnCreate.mock.calls[0][0].data.approvedBy).toBe("u-manager");
  });

  it("lets someone who may approve their own requests refund over the threshold alone", async () => {
    txState.threshold = "20.00";
    await service.refundSale(
      tenantId,
      branchId,
      userId,
      access(["sales.pos_use", "sales.refund", "returns.approve"], true),
      saleId,
      { reason: "x" },
    );
    expect(pharmacistApproval.verifyApproverPin).not.toHaveBeenCalled();
    expect(txState.goodsReturnCreate.mock.calls[0][0].data.approvedBy).toBe(userId);
  });

  it("rejects refund when prior GoodsReturn already consumed qty", async () => {
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          sale: {
            findFirst: jest.fn().mockResolvedValue({
              id: saleId,
              invoiceNo: "INV-1",
              status: SaleStatus.posted,
              prescriptionId: null,
              customer: null,
              items: [
                {
                  productId,
                  batchId,
                  qty: 2,
                  unitPrice: new Prisma.Decimal("10"),
                  lineTotal: new Prisma.Decimal("20"),
                  product: { id: productId, isControlled: false, name: "Para" },
                },
              ],
            }),
            update: txState.saleUpdate,
          },
          goodsReturn: {
            count: jest.fn().mockResolvedValue(0),
            create: txState.goodsReturnCreate,
            findMany: jest.fn().mockImplementation(({ where }: { where: { status: unknown } }) => {
              if (where.status === GoodsReturnStatus.completed) {
                return Promise.resolve([
                  { items: [{ productId, batchId, qty: 2 }] },
                ]);
              }
              return Promise.resolve([]);
            }),
          },
          stockLedger: {
            create: txState.stockLedgerCreate,
            groupBy: jest.fn().mockResolvedValue([]),
          },
          salePayment: { create: txState.salePaymentCreate },
          tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        return fn(tx);
      },
    );

    await expect(
      service.refundSale(tenantId, branchId, userId, cashierRoles, saleId, {
        reason: "Should fail",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(txState.goodsReturnCreate).not.toHaveBeenCalled();
  });
});
