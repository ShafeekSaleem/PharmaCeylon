import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  GoodsReturnStatus,
  PaymentMethod,
  Prisma,
  RoleName,
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
  let stock: { receive: jest.Mock; issue: jest.Mock };
  let txState: {
    goodsReturnCreate: jest.Mock;
    stockLedgerCreate: jest.Mock;
    salePaymentCreate: jest.Mock;
    saleUpdate: jest.Mock;
    completedReturns: { items: { productId: string; batchId: string; qty: number }[] }[];
  };

  beforeEach(() => {
    stock = { receive: jest.fn(), issue: jest.fn() };
    txState = {
      goodsReturnCreate: jest.fn().mockResolvedValue({
        id: "gr-1",
        returnNumber: "RET-2026-00001",
      }),
      stockLedgerCreate: jest.fn(),
      salePaymentCreate: jest.fn(),
      saleUpdate: jest.fn(),
      completedReturns: [],
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
        };
        return fn(tx);
      }),
    };

    audit = { log: jest.fn() } as unknown as AuditService;
    tax = { getVatRatePercent: () => 0 } as unknown as TaxService;
    const pharmacistApproval = {
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

  const cashierRoles = [{ branchId, role: RoleName.cashier }];
  const pharmacistRoles = [{ branchId, role: RoleName.pharmacist }];

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
        };
        return fn(tx);
      },
    );

    await service.refundSale(tenantId, branchId, userId, pharmacistRoles, saleId, {
      reason: "Pharmacist approved",
    });
    expect(txState.goodsReturnCreate).toHaveBeenCalled();
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
