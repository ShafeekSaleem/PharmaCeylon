import { StockBucket } from "@prisma/client";

/**
 * Quantity math for one batch, kept free of Prisma so every rule can be unit tested directly.
 *
 *   on hand     = every unit physically at the branch (sellable + quarantined)
 *   quarantined = units held back from sale and transfer
 *   reserved    = units promised to an approved document that hasn't moved yet
 *   sellable    = on hand − quarantined
 *   available   = sellable − reserved   (what can still be sold, transferred or promised)
 *
 * Expiry is deliberately not part of this: whether an expired unit may move depends on the
 * movement (a sale may not; a supplier return must), so callers decide that per operation.
 */
export type BatchQuantities = {
  onHand: number;
  quarantined: number;
  reserved: number;
};

export type BatchBalance = BatchQuantities & {
  sellable: number;
  available: number;
};

export const ZERO_QUANTITIES: BatchQuantities = { onHand: 0, quarantined: 0, reserved: 0 };

export function toBalance(q: BatchQuantities): BatchBalance {
  const sellable = q.onHand - q.quarantined;
  return { ...q, sellable, available: sellable - q.reserved };
}

export type BucketDelta = { bucket: StockBucket; qtyDelta: number };

export type BalanceViolation =
  | { kind: "insufficient_available"; available: number; requested: number }
  | { kind: "insufficient_quarantined"; quarantined: number; requested: number };

/**
 * Apply a batch's ledger deltas and say whether the result is allowed.
 *
 * A movement may only take from what it is taking from: removing sellable units needs that
 * many *available* (reserved units are spoken for), removing quarantined units needs that many
 * quarantined. Movements that only add are always allowed. `allowReservedShortfall` is for a
 * stocktake, where the count is the physical truth even if it leaves a reservation uncovered —
 * the transfer then fails to ship with a clear message instead of the count being refused.
 */
export function applyBucketDeltas(
  current: BatchQuantities,
  deltas: BucketDelta[],
  opts: { allowReservedShortfall?: boolean } = {},
): { next: BatchQuantities; violation: BalanceViolation | null } {
  let sellableDelta = 0;
  let quarantineDelta = 0;
  for (const d of deltas) {
    if (d.bucket === StockBucket.quarantine) quarantineDelta += d.qtyDelta;
    else sellableDelta += d.qtyDelta;
  }

  const next: BatchQuantities = {
    onHand: current.onHand + sellableDelta + quarantineDelta,
    quarantined: current.quarantined + quarantineDelta,
    reserved: current.reserved,
  };

  if (quarantineDelta < 0 && next.quarantined < 0) {
    return {
      next,
      violation: {
        kind: "insufficient_quarantined",
        quarantined: current.quarantined,
        requested: -quarantineDelta,
      },
    };
  }

  if (sellableDelta < 0) {
    const before = toBalance(current);
    const after = toBalance(next);
    const floor = opts.allowReservedShortfall ? after.sellable : after.available;
    if (floor < 0 || after.sellable < 0) {
      return {
        next,
        violation: {
          kind: "insufficient_available",
          available: opts.allowReservedShortfall ? before.sellable : before.available,
          requested: -sellableDelta,
        },
      };
    }
  }

  return { next, violation: null };
}

/**
 * Split an outbound quantity across buckets. `sellable` takes only available units;
 * `quarantine_first` drains held units before sellable ones (a supplier return is usually the
 * held stock going back); `sellable_first` does the reverse (a stocktake shortfall is more
 * likely unrecorded sales than missing quarantine stock).
 */
export function planIssue(
  balance: BatchBalance,
  qty: number,
  from: "sellable" | "quarantine" | "quarantine_first" | "sellable_first",
  opts: { allowReservedShortfall?: boolean } = {},
): BucketDelta[] {
  const sellablePool = Math.max(
    0,
    opts.allowReservedShortfall ? balance.sellable : balance.available,
  );
  if (from === "sellable") return [{ bucket: StockBucket.sellable, qtyDelta: -qty }];
  if (from === "quarantine") return [{ bucket: StockBucket.quarantine, qtyDelta: -qty }];

  const quarantinePool = Math.max(0, balance.quarantined);
  const [firstBucket, firstPool, secondBucket] =
    from === "quarantine_first"
      ? [StockBucket.quarantine, quarantinePool, StockBucket.sellable]
      : [StockBucket.sellable, sellablePool, StockBucket.quarantine];

  const first = Math.min(qty, firstPool);
  const rest = qty - first;
  const deltas: BucketDelta[] = [];
  if (first > 0) deltas.push({ bucket: firstBucket, qtyDelta: -first });
  if (rest > 0) deltas.push({ bucket: secondBucket, qtyDelta: -rest });
  return deltas;
}

/** A batch whose every on-hand unit is held — what `Batch.isQuarantined` now means. */
export function isWhollyQuarantined(q: BatchQuantities): boolean {
  return q.onHand > 0 && q.quarantined >= q.onHand;
}
