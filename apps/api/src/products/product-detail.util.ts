import { PrismaService } from "../prisma/prisma.service";
import { resolveStockStatus, stockQtyByProductId } from "./stock-qty.util";

export type ProductDetailBatch = {
  id: string;
  batchNo: string;
  expiryDate: string;
  costPrice: string;
  sellingPrice: string;
  receivedAt: string;
  qtyOnHand: number;
  daysToExpiry: number;
  nearExpiry: boolean;
  expired: boolean;
  fefoPriority: number;
};

export type ProductBranchStockRow = {
  branchId: string;
  branchName: string;
  qtyOnHand: number;
  availableQty: number;
  reservedQty: number;
  reorderLevel: number;
  stockStatus: "out" | "low" | "ok";
  lastMovementAt: string | null;
  lastMovementType: string | null;
  isCurrentBranch: boolean;
};

export type ProductStockMovement = {
  id: string;
  occurredAt: string;
  movementType: string;
  referenceType: string;
  referenceId: string;
  reason?: string | null;
  batchNo: string | null;
  qtyDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  actorName: string | null;
};

export type ProductBranchSummary = {
  branchId: string;
  branchName: string;
  lastMovementAt: string | null;
  nextExpiryBatchNo: string | null;
  nextExpiryDate: string | null;
  nextExpiryDays: number | null;
  nearExpiryBatchCount: number;
  primarySellingPrice: string | null;
  primaryCostPrice: string | null;
  marginPercent: number | null;
  avgMonthlyUsage: number | null;
};

function daysToExpiry(expiryDate: Date): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const exp = new Date(expiryDate);
  exp.setHours(0, 0, 0, 0);
  return Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function marginPercent(sell: number, cost: number): number | null {
  if (sell <= 0 || Number.isNaN(sell) || Number.isNaN(cost)) return null;
  return Math.round(((sell - cost) / sell) * 100);
}

export async function buildProductDetailExtras(
  prisma: PrismaService,
  tenantId: string,
  branchId: string | undefined,
  productId: string,
  reorderLevel: number,
) {
  const branches = await prisma.branch.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const branchStock: ProductBranchStockRow[] = await Promise.all(
    branches.map(async (branch) => {
      const agg = await prisma.stockLedger.aggregate({
        where: { tenantId, branchId: branch.id, productId },
        _sum: { qtyDelta: true },
      });
      const qtyOnHand = agg._sum.qtyDelta ?? 0;
      const last = await prisma.stockLedger.findFirst({
        where: { tenantId, branchId: branch.id, productId },
        orderBy: { occurredAt: "desc" },
        select: { occurredAt: true, movementType: true },
      });
      return {
        branchId: branch.id,
        branchName: branch.name,
        qtyOnHand,
        availableQty: qtyOnHand,
        reservedQty: 0,
        reorderLevel,
        stockStatus: resolveStockStatus(qtyOnHand, reorderLevel),
        lastMovementAt: last?.occurredAt.toISOString() ?? null,
        lastMovementType: last?.movementType ?? null,
        isCurrentBranch: branch.id === branchId,
      };
    }),
  );

  if (!branchId) {
    return {
      branchName: null,
      batches: [] as ProductDetailBatch[],
      branchStock,
      movements: [] as ProductStockMovement[],
      branchSummary: null as ProductBranchSummary | null,
      avgMonthlyUsage: null as number | null,
    };
  }

  const currentBranch = branches.find((b) => b.id === branchId);
  const stockMap = await stockQtyByProductId(prisma, tenantId, branchId, [productId]);
  const qtyOnHand = stockMap.get(productId) ?? 0;

  const rawBatches = await prisma.batch.findMany({
    where: { tenantId, branchId, productId },
    orderBy: { expiryDate: "asc" },
  });

  const batchIds = rawBatches.map((b) => b.id);
  const batchQtyMap = new Map<string, number>();
  if (batchIds.length > 0) {
    const grouped = await prisma.stockLedger.groupBy({
      by: ["batchId"],
      where: { tenantId, branchId, batchId: { in: batchIds } },
      _sum: { qtyDelta: true },
    });
    for (const g of grouped) {
      if (g.batchId) batchQtyMap.set(g.batchId, g._sum.qtyDelta ?? 0);
    }
  }

  const batchesWithQty = rawBatches.map((b, index) => {
    const qty = batchQtyMap.get(b.id) ?? 0;
    const days = daysToExpiry(b.expiryDate);
    const expired = days < 0;
    const nearExpiry = !expired && days <= 30;
    return { batch: b, qty, days, expired, nearExpiry, index };
  });

  const fefoRanked = [...batchesWithQty]
    .filter((b) => b.qty > 0)
    .sort((a, b) => a.batch.expiryDate.getTime() - b.batch.expiryDate.getTime());
  const fefoMap = new Map(fefoRanked.map((b, i) => [b.batch.id, i + 1]));

  const batches: ProductDetailBatch[] = batchesWithQty.map((row) => ({
    id: row.batch.id,
    batchNo: row.batch.batchNo,
    expiryDate: row.batch.expiryDate.toISOString().slice(0, 10),
    costPrice: String(row.batch.costPrice),
    sellingPrice: String(row.batch.sellingPrice),
    receivedAt: row.batch.receivedAt.toISOString(),
    qtyOnHand: row.qty,
    daysToExpiry: row.days,
    nearExpiry: row.nearExpiry,
    expired: row.expired,
    fefoPriority: fefoMap.get(row.batch.id) ?? 0,
  }));

  const nearExpiryBatchCount = batches.filter((b) => b.nearExpiry && b.qtyOnHand > 0).length;
  const nextBatch = fefoRanked.find((b) => !b.expired) ?? fefoRanked[0] ?? null;
  const primaryBatch = fefoRanked[0]?.batch ?? rawBatches[0] ?? null;
  const primarySell = primaryBatch ? Number(primaryBatch.sellingPrice) : null;
  const primaryCost = primaryBatch ? Number(primaryBatch.costPrice) : null;

  const lastLedger = await prisma.stockLedger.findFirst({
    where: { tenantId, branchId, productId },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });

  const soldAgg = await prisma.stockLedger.aggregate({
    where: {
      tenantId,
      branchId,
      productId,
      movementType: "sale_out",
      occurredAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
    _sum: { qtyDelta: true },
  });
  const soldUnits = Math.abs(soldAgg._sum.qtyDelta ?? 0);
  const avgMonthlyUsage = Math.round((soldUnits / 3) * 10) / 10;

  const branchSummary: ProductBranchSummary = {
    branchId,
    branchName: currentBranch?.name ?? "Branch",
    lastMovementAt: lastLedger?.occurredAt.toISOString() ?? null,
    nextExpiryBatchNo: nextBatch?.batch.batchNo ?? null,
    nextExpiryDate: nextBatch ? nextBatch.batch.expiryDate.toISOString().slice(0, 10) : null,
    nextExpiryDays: nextBatch ? nextBatch.days : null,
    nearExpiryBatchCount,
    primarySellingPrice: primarySell != null ? String(primarySell) : null,
    primaryCostPrice: primaryCost != null ? String(primaryCost) : null,
    marginPercent:
      primarySell != null && primaryCost != null
        ? marginPercent(primarySell, primaryCost)
        : null,
    avgMonthlyUsage,
  };

  const rawMovements = await prisma.stockLedger.findMany({
    where: { tenantId, branchId, productId },
    orderBy: { occurredAt: "desc" },
    take: 15,
    include: {
      batch: { select: { batchNo: true } },
      actor: { select: { fullName: true } },
    },
  });

  let runningBalance = qtyOnHand;
  const movements: ProductStockMovement[] = rawMovements.map((m) => {
    const balanceAfter = runningBalance;
    const balanceBefore = runningBalance - m.qtyDelta;
    runningBalance = balanceBefore;
    return {
      id: m.id,
      occurredAt: m.occurredAt.toISOString(),
      movementType: m.movementType,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      reason: m.reason ?? null,
      batchNo: m.batch?.batchNo ?? null,
      qtyDelta: m.qtyDelta,
      balanceBefore,
      balanceAfter,
      actorName: m.actor?.fullName ?? null,
    };
  });

  return {
    branchName: currentBranch?.name ?? null,
    batches,
    branchStock,
    movements,
    branchSummary,
    avgMonthlyUsage,
  };
}
