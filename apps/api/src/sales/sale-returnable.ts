import { BadRequestException } from "@nestjs/common";
import {
  GoodsReturnStatus,
  Prisma,
  SaleStatus,
  StockMovementType,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export type DbClient = Prisma.TransactionClient | PrismaClient;

export const OPEN_RETURN_STATUSES: GoodsReturnStatus[] = [
  GoodsReturnStatus.draft,
  GoodsReturnStatus.pending_approval,
  GoodsReturnStatus.awaiting_logistics,
  GoodsReturnStatus.in_review,
];

export function saleLineKey(productId: string, batchId: string | null | undefined): string {
  return `${productId}:${batchId ?? ""}`;
}

export type ReturnableLine = {
  productId: string;
  batchId: string;
  soldQty: number;
  usedQty: number;
  remainingQty: number;
  unitPrice: string;
};

/**
 * Remaining returnable qty per sale line (productId:batchId).
 * Counts completed + open GoodsReturns, legacy sale_refund_in / sale_void_in,
 * and inventory-tagged customer_return_in (not goods_return refs).
 */
export async function getSaleReturnableByLine(
  db: DbClient,
  tenantId: string,
  branchId: string,
  saleId: string,
  excludeReturnId?: string,
): Promise<{
  saleStatus: SaleStatus;
  lines: Map<string, ReturnableLine>;
}> {
  const sale = await db.sale.findFirst({
    where: { id: saleId, tenantId, branchId },
    include: { items: true },
  });
  if (!sale) throw new BadRequestException("Sale not found for this branch");

  const lines = new Map<string, ReturnableLine>();
  for (const si of sale.items) {
    const key = saleLineKey(si.productId, si.batchId);
    const existing = lines.get(key);
    if (existing) {
      existing.soldQty += si.qty;
    } else {
      lines.set(key, {
        productId: si.productId,
        batchId: si.batchId,
        soldQty: si.qty,
        usedQty: 0,
        remainingQty: 0,
        unitPrice: si.unitPrice.toFixed(2),
      });
    }
  }

  const addUsed = (productId: string, batchId: string | null | undefined, qty: number) => {
    const key = saleLineKey(productId, batchId);
    const row = lines.get(key);
    if (row) row.usedQty += qty;
  };

  const completedReturns = await db.goodsReturn.findMany({
    where: {
      tenantId,
      branchId,
      saleId,
      status: GoodsReturnStatus.completed,
      ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
    },
    include: { items: true },
  });
  for (const gr of completedReturns) {
    for (const item of gr.items) {
      addUsed(item.productId, item.batchId, item.qty);
    }
  }

  const openReturns = await db.goodsReturn.findMany({
    where: {
      tenantId,
      branchId,
      saleId,
      status: { in: OPEN_RETURN_STATUSES },
      ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
    },
    include: { items: true },
  });
  for (const gr of openReturns) {
    for (const item of gr.items) {
      addUsed(item.productId, item.batchId, item.qty);
    }
  }

  const refundLedger = await db.stockLedger.groupBy({
    by: ["productId", "batchId"],
    where: {
      tenantId,
      branchId,
      movementType: StockMovementType.sale_refund_in,
      referenceId: saleId,
    },
    _sum: { qtyDelta: true },
  });
  for (const row of refundLedger) {
    addUsed(row.productId, row.batchId, row._sum.qtyDelta ?? 0);
  }

  const voidLedger = await db.stockLedger.groupBy({
    by: ["productId", "batchId"],
    where: {
      tenantId,
      branchId,
      movementType: StockMovementType.sale_void_in,
      referenceId: saleId,
    },
    _sum: { qtyDelta: true },
  });
  for (const row of voidLedger) {
    addUsed(row.productId, row.batchId, row._sum.qtyDelta ?? 0);
  }

  // Legacy inventory customer-returns tagged reason sale:{saleId} (not goods_return ledger rows).
  const inventoryTagged = await db.stockLedger.groupBy({
    by: ["productId", "batchId"],
    where: {
      tenantId,
      branchId,
      movementType: StockMovementType.customer_return_in,
      referenceType: { not: "goods_return" },
      OR: [{ reason: `sale:${saleId}` }, { reason: { startsWith: `sale:${saleId}` } }],
    },
    _sum: { qtyDelta: true },
  });
  for (const row of inventoryTagged) {
    addUsed(row.productId, row.batchId, row._sum.qtyDelta ?? 0);
  }

  for (const row of lines.values()) {
    row.remainingQty = Math.max(0, row.soldQty - row.usedQty);
  }

  return { saleStatus: sale.status, lines };
}

export async function assertSaleReturnableLines(
  db: DbClient,
  tenantId: string,
  branchId: string,
  saleId: string,
  items: { productId: string; batchId: string; qty: number }[],
  excludeReturnId?: string,
): Promise<Map<string, ReturnableLine>> {
  const { saleStatus, lines } = await getSaleReturnableByLine(
    db,
    tenantId,
    branchId,
    saleId,
    excludeReturnId,
  );

  if (saleStatus === SaleStatus.voided) {
    throw new BadRequestException("Cannot return against a voided sale");
  }
  if (saleStatus === SaleStatus.refunded) {
    throw new BadRequestException("This sale has already been fully refunded");
  }

  const requestedByKey = new Map<string, number>();
  for (const line of items) {
    const key = saleLineKey(line.productId, line.batchId);
    if (!lines.has(key)) {
      throw new BadRequestException(
        "Return line product/batch must match a line on the referenced sale",
      );
    }
    requestedByKey.set(key, (requestedByKey.get(key) ?? 0) + line.qty);
  }

  for (const [key, requested] of requestedByKey) {
    const row = lines.get(key)!;
    if (requested > row.remainingQty) {
      throw new BadRequestException(
        row.remainingQty <= 0
          ? "This sale line has already been fully returned"
          : `Only ${row.remainingQty} unit(s) remain returnable on this sale line`,
      );
    }
  }

  return lines;
}

export function totalRemainingQty(lines: Map<string, ReturnableLine>): number {
  let n = 0;
  for (const row of lines.values()) n += row.remainingQty;
  return n;
}
