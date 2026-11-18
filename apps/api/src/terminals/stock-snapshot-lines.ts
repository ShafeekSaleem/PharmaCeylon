import { SNAPSHOT_DISPLAY_LIMITS, type StockSnapshotDisplay, type StockSnapshotLine } from "@pharmaceylon/shared";
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
      batchNo: true,
      expiryDate: true,
      sellingPrice: true,
      stock: { select: { onHandQty: true, quarantinedQty: true, reservedQty: true } },
      product: { select: { name: true, strength: true, barcode: true } },
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
      display: snapshotDisplay(batch),
    });
  }
  return lines;
}

/** Trimmed and clipped to the signed bounds; empty optional text is null. */
function clip(value: string | null | undefined, max: number): string | null {
  const text = value?.trim() ?? "";
  return text ? text.slice(0, max).trim() : null;
}

/**
 * P4 #50: what the offline counter shows and prints for a batch. Clipped here so an unusually long
 * name can never make the whole snapshot fail its bounds and stop the counter selling offline.
 */
export function snapshotDisplay(batch: {
  id: string;
  batchNo: string;
  product: { name: string; strength: string | null; barcode: string | null };
}): StockSnapshotDisplay {
  return {
    name: clip(batch.product.name, SNAPSHOT_DISPLAY_LIMITS.name) ?? "Unnamed product",
    strength: clip(batch.product.strength, SNAPSHOT_DISPLAY_LIMITS.strength),
    barcode: clip(batch.product.barcode, SNAPSHOT_DISPLAY_LIMITS.barcode),
    batchNo: clip(batch.batchNo, SNAPSHOT_DISPLAY_LIMITS.batchNo) ?? batch.id.slice(0, 8),
  };
}
