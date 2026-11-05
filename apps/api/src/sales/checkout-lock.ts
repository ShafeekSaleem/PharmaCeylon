import type { Prisma } from "@prisma/client";

/**
 * The lock one checkout key's attempts serialize on. Checkout takes it before it looks for an
 * earlier attempt; resolving the key from another sign-in takes the same one, so it can never
 * answer while the original attempt is between its lookup and its commit. Hash collisions only
 * over-serialize.
 */
export function lockCheckoutKey(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sellerId: string,
  idempotencyKey: string,
) {
  const lockKey = `checkout:${tenantId}:${sellerId}:${idempotencyKey}`;
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

/**
 * A checkout key someone else at the counter resolved as never landed. Same tenant, seller and
 * key as the checkout record it stands in for; `resourceId` is the work session that sealed it.
 * Once it exists, checkout refuses that key for good.
 */
export const CHECKOUT_SEALED_SCOPE = "checkout_sealed";
