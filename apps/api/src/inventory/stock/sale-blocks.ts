import type { Prisma } from "@prisma/client";

/**
 * P5 #51, approved D1: the batches an open offline discrepancy case still holds. Central
 * checkout refuses them and offline snapshots mark them `stockReviewRequired`; every other
 * batch, including other batches of the same product, keeps selling.
 *
 * Read under the batch row locks (`StockService.lockBatches`): the sync that opens a case takes
 * the same locks before it adds the block, so a checkout either sees the block or posts first.
 */
export async function blockedBatchIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  batchIds?: readonly string[],
): Promise<Set<string>> {
  if (batchIds && batchIds.length === 0) return new Set();
  const rows = await tx.batchSaleBlock.findMany({
    where: {
      tenantId,
      branchId,
      releasedAt: null,
      ...(batchIds ? { batchId: { in: [...new Set(batchIds)] } } : {}),
    },
    select: { batchId: true },
  });
  return new Set(rows.map((row) => row.batchId));
}
