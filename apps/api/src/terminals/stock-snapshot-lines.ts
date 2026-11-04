import type { StockSnapshotLine } from "@pharmaceylon/shared";
import type { Prisma } from "@prisma/client";
import { addDays, businessToday, startOfBusinessDay } from "../common/business-date.util";

/** Read within the same transaction as the journal watermark and review blocks. */
export async function readStockSnapshotLines(
  tx: Prisma.TransactionClient,
  scope: { tenantId: string; branchId: string },
  policy: {
    generatedAt: Date;
    timeZone: string;
    taxBasisPoints: number;
    reviewRequiredBatchIds: ReadonlySet<string>;
  },
): Promise<StockSnapshotLine[]> {
  const batches = await tx.batch.findMany({
    where: {
      ...scope,
      needsExpiryReview: false,
      expiryDate: { gte: businessToday(policy.timeZone, policy.generatedAt) },
      product: {
        tenantId: scope.tenantId,
        isActive: true,
        rangeStatus: "RANGED",
        isControlled: false,
        requiresPrescription: false,
      },
      stock: { is: { ...scope, onHandQty: { gt: 0 } } },
    },
    select: {
      id: true,
      productId: true,
      expiryDate: true,
      sellingPrice: true,
      stock: { select: { onHandQty: true, quarantinedQty: true, reservedQty: true } },
    },
    orderBy: [{ expiryDate: "asc" }, { id: "asc" }],
  });

  const lines: StockSnapshotLine[] = [];
  for (const batch of batches) {
    const stock = batch.stock;
    if (!stock) continue;
    const availableQuantity = stock.onHandQty - stock.quarantinedQty - stock.reservedQty;
    if (availableQuantity <= 0) continue;

    const dayAfterExpiry = addDays(batch.expiryDate, 1).toISOString().slice(0, 10);
    lines.push({
      snapshotLineId: batch.id,
      productId: batch.productId,
      batchId: batch.id,
      availableQuantity,
      stockReviewRequired: policy.reviewRequiredBatchIds.has(batch.id),
      unitPriceMinor: batch.sellingPrice.mul(100).toNumber(),
      taxBasisPoints: policy.taxBasisPoints,
      sellBefore: startOfBusinessDay(policy.timeZone, dayAfterExpiry).getTime(),
    });
  }
  return lines;
}
