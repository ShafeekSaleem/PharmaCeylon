import { PrismaService } from "../prisma/prisma.service";

export type StockStatus = "out" | "low" | "ok";

export function resolveStockStatus(
  qtyOnHand: number,
  reorderLevel: number,
): StockStatus {
  if (qtyOnHand <= 0) return "out";
  if (reorderLevel > 0 && qtyOnHand <= reorderLevel) return "low";
  return "ok";
}

export function reorderGap(qtyOnHand: number, reorderLevel: number): number {
  return Math.max(0, reorderLevel - qtyOnHand);
}

/** Branch-level on-hand quantities keyed by product id. */
export async function stockQtyByProductId(
  prisma: PrismaService,
  tenantId: string,
  branchId: string,
  productIds?: string[],
): Promise<Map<string, number>> {
  const grouped = await prisma.stockLedger.groupBy({
    by: ["productId"],
    where: {
      tenantId,
      branchId,
      ...(productIds?.length ? { productId: { in: productIds } } : {}),
    },
    _sum: { qtyDelta: true },
  });
  return new Map(grouped.map((g) => [g.productId, g._sum.qtyDelta ?? 0]));
}

export function attachStockFields<T extends { id: string; reorderLevel: number }>(
  items: T[],
  stockMap: Map<string, number> | null,
): (T & {
  qtyOnHand: number | null;
  stockStatus: StockStatus | null;
  reorderGap: number | null;
})[] {
  if (!stockMap) {
    return items.map((p) => ({
      ...p,
      qtyOnHand: null,
      stockStatus: null,
      reorderGap: null,
    }));
  }
  return items.map((p) => {
    const qtyOnHand = stockMap.get(p.id) ?? 0;
    return {
      ...p,
      qtyOnHand,
      stockStatus: resolveStockStatus(qtyOnHand, p.reorderLevel),
      reorderGap: reorderGap(qtyOnHand, p.reorderLevel),
    };
  });
}
