import { StocktakeStatus, type Prisma } from "@prisma/client";

const POSTED_STOCKTAKE: StocktakeStatus[] = [
  StocktakeStatus.posted,
  StocktakeStatus.completed,
];

export type CountAfterSale = Readonly<
  | {
      batchId: string;
      countedAt: Date;
      source: "stocktake";
      stocktakeNumber: string;
    }
  | { batchId: string; countedAt: Date; source: "case_count"; caseId: string }
>;

/**
 * P5 #51: counts of these batches made after an offline sale that already took its units off,
 * so posting them now would deduct them twice. A posted stocktake line counted after `soldAt`, or
 * an offline stock case's own count ("count and correct") made after `soldAt` and before
 * `caseOpenedAt`: a case count made while the sale's own case was open kept that case's units
 * pending on the batch, so it took none of them off. At intake there is no case yet, so every
 * later count counts.
 *
 * A late sale reaches the server whenever its counter reconnects, which after a store restore can
 * be long after the shop counted the shelf.
 */
export async function countsAfterSale(
  tx: Prisma.TransactionClient,
  scope: { tenantId: string; branchId: string },
  batchIds: readonly string[],
  soldAt: Date,
  caseOpenedAt?: Date,
): Promise<CountAfterSale[]> {
  if (batchIds.length === 0) return [];
  const { tenantId, branchId } = scope;
  const ids = [...new Set(batchIds)];
  const stocktakes = await tx.stocktakeLine.findMany({
    where: {
      tenantId,
      batchId: { in: ids },
      countedAt: { gt: soldAt },
      postedAt: { not: null },
      stocktake: { tenantId, branchId, status: { in: POSTED_STOCKTAKE } },
    },
    select: {
      batchId: true,
      countedAt: true,
      stocktake: { select: { stocktakeNumber: true } },
    },
    orderBy: [{ countedAt: "asc" }, { id: "asc" }],
  });
  const caseCounts = await tx.offlineStockSettlement.findMany({
    where: {
      tenantId,
      branchId,
      batchId: { in: ids },
      method: "counted",
      countedAt: { gt: soldAt, ...(caseOpenedAt ? { lt: caseOpenedAt } : {}) },
    },
    select: { batchId: true, countedAt: true, caseId: true },
    orderBy: [{ countedAt: "asc" }, { id: "asc" }],
  });
  return [
    ...stocktakes.map((s) => ({
      batchId: s.batchId,
      countedAt: s.countedAt!,
      source: "stocktake" as const,
      stocktakeNumber: s.stocktake.stocktakeNumber,
    })),
    ...caseCounts.map((c) => ({
      batchId: c.batchId,
      countedAt: c.countedAt!,
      source: "case_count" as const,
      caseId: c.caseId,
    })),
  ];
}
