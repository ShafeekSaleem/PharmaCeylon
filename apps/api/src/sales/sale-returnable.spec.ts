import { BadRequestException } from "@nestjs/common";
import { GoodsReturnStatus, Prisma, SaleStatus, StockMovementType } from "@prisma/client";
import {
  assertSaleReturnableLines,
  getSaleReturnableByLine,
  saleLineKey,
  totalRemainingQty,
} from "./sale-returnable";

function decimal(n: string | number) {
  return new Prisma.Decimal(n);
}

describe("sale-returnable", () => {
  const tenantId = "t1";
  const branchId = "b1";
  const saleId = "sale-1";
  const productId = "p1";
  const batchId = "batch-1";
  const key = saleLineKey(productId, batchId);

  function mockDb(overrides: {
    status?: SaleStatus;
    soldQty?: number;
    completedQty?: number;
    openQty?: number;
    refundLedgerQty?: number;
    voidLedgerQty?: number;
    inventoryTaggedQty?: number;
  }) {
    const soldQty = overrides.soldQty ?? 10;
    return {
      sale: {
        findFirst: jest.fn().mockResolvedValue({
          id: saleId,
          status: overrides.status ?? SaleStatus.posted,
          items: [
            {
              productId,
              batchId,
              qty: soldQty,
              unitPrice: decimal("25.00"),
            },
          ],
        }),
      },
      goodsReturn: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { status: unknown } }) => {
          if (where.status === GoodsReturnStatus.completed) {
            const qty = overrides.completedQty ?? 0;
            return Promise.resolve(
              qty
                ? [{ items: [{ productId, batchId, qty }] }]
                : [],
            );
          }
          const qty = overrides.openQty ?? 0;
          return Promise.resolve(
            qty ? [{ items: [{ productId, batchId, qty }] }] : [],
          );
        }),
      },
      stockLedger: {
        groupBy: jest.fn().mockImplementation(({ where }: { where: { movementType: string } }) => {
          if (where.movementType === StockMovementType.sale_refund_in) {
            const qty = overrides.refundLedgerQty ?? 0;
            return Promise.resolve(
              qty ? [{ productId, batchId, _sum: { qtyDelta: qty } }] : [],
            );
          }
          if (where.movementType === StockMovementType.sale_void_in) {
            const qty = overrides.voidLedgerQty ?? 0;
            return Promise.resolve(
              qty ? [{ productId, batchId, _sum: { qtyDelta: qty } }] : [],
            );
          }
          if (where.movementType === StockMovementType.customer_return_in) {
            const qty = overrides.inventoryTaggedQty ?? 0;
            return Promise.resolve(
              qty ? [{ productId, batchId, _sum: { qtyDelta: qty } }] : [],
            );
          }
          return Promise.resolve([]);
        }),
      },
    };
  }

  it("computes remaining after GoodsReturn + legacy refund + void ledgers", async () => {
    const db = mockDb({
      soldQty: 10,
      completedQty: 2,
      openQty: 1,
      refundLedgerQty: 3,
      voidLedgerQty: 0,
      inventoryTaggedQty: 1,
    });

    const { lines } = await getSaleReturnableByLine(db as never, tenantId, branchId, saleId);
    expect(lines.get(key)?.remainingQty).toBe(3); // 10 - 2 - 1 - 3 - 1
    expect(totalRemainingQty(lines)).toBe(3);
  });

  it("rejects return against voided sale", async () => {
    const db = mockDb({ status: SaleStatus.voided, soldQty: 5 });
    await expect(
      assertSaleReturnableLines(db as never, tenantId, branchId, saleId, [
        { productId, batchId, qty: 1 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects return against fully refunded sale", async () => {
    const db = mockDb({ status: SaleStatus.refunded, soldQty: 5 });
    await expect(
      assertSaleReturnableLines(db as never, tenantId, branchId, saleId, [
        { productId, batchId, qty: 1 },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects over-qty after prior GoodsReturn", async () => {
    const db = mockDb({ soldQty: 5, completedQty: 4 });
    await expect(
      assertSaleReturnableLines(db as never, tenantId, branchId, saleId, [
        { productId, batchId, qty: 2 },
      ]),
    ).rejects.toThrow(/Only 1 unit/);
  });

  it("allows remaining qty on partially refunded sale", async () => {
    const db = mockDb({
      status: SaleStatus.partially_refunded,
      soldQty: 5,
      completedQty: 2,
    });
    const lines = await assertSaleReturnableLines(db as never, tenantId, branchId, saleId, [
      { productId, batchId, qty: 2 },
    ]);
    expect(lines.get(key)?.remainingQty).toBe(3);
  });
});
