import { Prisma } from "@prisma/client";

/**
 * Promote products into the pharmacy's own range because stock has arrived against them.
 *
 * Stock can never exist against a product the shop has not ranged, so every path that puts
 * units on a shelf — goods receipt, opening-stock import, adjustment in — calls this rather
 * than each one inventing its own rule. Only REFERENCE rows are touched, so a deliberately
 * deactivated (RANGED + inactive) product is never silently re-enabled: `isActive` stays the
 * pharmacist's to set.
 *
 * Safe to call with an empty list, with already-ranged ids, and inside a transaction —
 * pass the transaction client as `client` so the promotion commits or rolls back with the
 * stock movement that triggered it.
 */
export async function ensureProductsRanged(
  client: Prisma.TransactionClient,
  tenantId: string,
  productIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return 0;

  const result = await client.product.updateMany({
    where: { tenantId, id: { in: ids }, rangeStatus: "REFERENCE" },
    data: { rangeStatus: "RANGED", rangedAt: new Date() },
  });
  return result.count;
}
