import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  OFFLINE_STOCK_RESOLUTION_KINDS,
  terminalSigningText,
  type OfflineStockResolutionKind,
} from "@pharmaceylon/shared";

/**
 * P5 #51 slice 2: the pure rules of resolving an offline stock discrepancy case. Nothing here
 * reads or writes the database; the service locks, reads and posts through StockService.
 */

/** What already accounted for one batch's units (link_existing_settlement only). */
export type SettlementLink =
  | Readonly<{ batchId: string; source: "stocktake"; stocktakeId: string }>
  | Readonly<{ batchId: string; source: "movements"; ledgerEntryIds: readonly string[] }>;

export type CaseLineFacts = Readonly<{
  batchId: string;
  productId: string;
  soldQuantity: number;
  availableQuantityAtSync: number;
  shortfallQuantity: number;
  reason: string;
}>;

/** Another open case holding the same batch, and its pending units there. */
export type OtherOpenCase = Readonly<{ batchId: string; caseId: string; soldQuantity: number }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bad = (message: string): never => {
  throw new BadRequestException(message);
};
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export function parseKind(raw: unknown): OfflineStockResolutionKind {
  if (!(OFFLINE_STOCK_RESOLUTION_KINDS as readonly unknown[]).includes(raw))
    bad(`Resolution must be one of ${OFFLINE_STOCK_RESOLUTION_KINDS.join(", ")}`);
  return raw as OfflineStockResolutionKind;
}

/**
 * The plan's links, checked against the case: one per case batch for link_existing_settlement
 * (in batch order, so equal plans store equal JSON), none for the other kinds.
 */
export function normalizeLinks(
  kind: OfflineStockResolutionKind,
  raw: unknown,
  caseBatchIds: readonly string[],
): SettlementLink[] {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) return bad("links must be a list");
  if (kind !== "link_existing_settlement") {
    if (list.length) bad("Only link_existing_settlement names existing settlements");
    return [];
  }
  const wanted = new Set(caseBatchIds);
  const seen = new Set<string>();
  const links: SettlementLink[] = [];
  for (const item of list as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) bad("Each link must be an object");
    const link = item as Record<string, unknown>;
    if (!isUuid(link.batchId) || !wanted.has(link.batchId)) bad("Each link must name a batch of this case");
    const batchId = link.batchId as string;
    if (seen.has(batchId)) bad("Each batch is linked once");
    seen.add(batchId);
    if (link.source === "stocktake") {
      if (!isUuid(link.stocktakeId) || Object.keys(link).length !== 3) bad("A stocktake link names one stocktake");
      links.push({ batchId, source: "stocktake", stocktakeId: (link.stocktakeId as string).toLowerCase() });
    } else if (link.source === "movements") {
      const ids = link.ledgerEntryIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 20 || !ids.every(isUuid) || Object.keys(link).length !== 3)
        bad("A movement link names 1 to 20 stock movements");
      const normalized = (ids as string[]).map((id) => id.toLowerCase());
      if (new Set(normalized).size !== normalized.length) bad("A movement is named once");
      links.push({ batchId, source: "movements", ledgerEntryIds: normalized });
    } else bad("A link's source is stocktake or movements");
  }
  if (seen.size !== wanted.size) bad("link_existing_settlement needs a link for every batch of the case");
  return links.sort((a, b) => a.batchId.localeCompare(b.batchId));
}

/**
 * Approved content: the case, the plan, and which other open cases hold each batch. A new case
 * on one of the batches changes what a count must account for, so it needs fresh approval; the
 * plan's note and execution progress are not material.
 */
export function resolutionMaterial(input: {
  caseId: string;
  saleId: string;
  commandId: string;
  kind: OfflineStockResolutionKind;
  lines: readonly CaseLineFacts[];
  links: readonly SettlementLink[];
  otherOpenCases: readonly OtherOpenCase[];
}): Prisma.InputJsonObject {
  const items = [...input.lines]
    .sort((a, b) => a.batchId.localeCompare(b.batchId))
    .map((line) => ({
      batchId: line.batchId,
      productId: line.productId,
      soldQuantity: line.soldQuantity,
      availableQuantityAtSync: line.availableQuantityAtSync,
      shortfallQuantity: line.shortfallQuantity,
      reason: line.reason,
      otherOpenCases: input.otherOpenCases
        .filter((other) => other.batchId === line.batchId)
        .sort((a, b) => a.caseId.localeCompare(b.caseId))
        .map((other) => ({ caseId: other.caseId, soldQuantity: other.soldQuantity })),
      link: (input.links.find((link) => link.batchId === line.batchId) ?? null) as Prisma.InputJsonValue | null,
    }));
  return {
    caseId: input.caseId,
    saleId: input.saleId,
    commandId: input.commandId,
    kind: input.kind,
    items,
  };
}

/**
 * The counts a count_and_correct command carries: exactly one whole, non-negative count per case
 * batch. Other kinds carry none.
 */
export function checkCounts(
  kind: OfflineStockResolutionKind,
  counts: ReadonlyArray<Readonly<{ batchId: string; countedQty: number }>>,
  caseBatchIds: readonly string[],
): Map<string, number> {
  const byBatch = new Map<string, number>();
  if (kind !== "count_and_correct") {
    if (counts.length) bad("Only count_and_correct takes counts");
    return byBatch;
  }
  for (const count of counts) {
    if (!caseBatchIds.includes(count.batchId)) bad("A count names a batch that is not in this case");
    if (byBatch.has(count.batchId)) bad("Each batch is counted once");
    if (!Number.isSafeInteger(count.countedQty) || count.countedQty < 0 || count.countedQty > 10_000_000)
      bad("A count is a whole number of units, 0 or more");
    byBatch.set(count.batchId, count.countedQty);
  }
  if (byBatch.size !== caseBatchIds.length) bad("Count every batch of the case");
  return byBatch;
}

/**
 * count_and_correct for one batch. The count is taken after the offline sales left the shelf, so
 * it already reflects every open case's pending units on the batch, this one's included. Central
 * on hand should therefore be the count plus those pending units just before this sale posts:
 * after posting, it equals the count plus what the other open cases still have to post. That is
 * the correction — positive or negative, exactly once — and nothing is deducted twice.
 */
export function countCorrection(input: { countedQty: number; pendingOnBatch: number; onHandBefore: number }) {
  const target = input.countedQty + input.pendingOnBatch;
  return { target, correctionQty: target - input.onHandBefore };
}

/** Units a movement took off that earlier links have not claimed. */
export type MovementCapacity = Readonly<{ ledgerEntryId: string; remaining: number }>;

/**
 * Spreads a batch's sold units over the named movements, in the order named, never past what each
 * still has unclaimed. Null when they cannot account for every unit: a partial link is refused.
 */
export function allocateMovementLinks(
  soldQuantity: number,
  capacities: readonly MovementCapacity[],
): Array<{ ledgerEntryId: string; quantity: number }> | null {
  let left = soldQuantity;
  const out: Array<{ ledgerEntryId: string; quantity: number }> = [];
  for (const capacity of capacities) {
    if (left === 0) break;
    const take = Math.min(left, Math.max(0, capacity.remaining));
    if (take > 0) out.push({ ledgerEntryId: capacity.ledgerEntryId, quantity: take });
    left -= take;
  }
  return left === 0 ? out : null;
}

export type TimelineEntry = Readonly<{
  id: string;
  occurredAt: string;
  movementType: string;
  bucket: string;
  qtyDelta: number;
  referenceType: string;
  referenceId: string;
}>;

/** A stable digest of a batch's ledger since the snapshot, recorded with each settlement. */
export function timelineDigest(batchId: string, entries: readonly TimelineEntry[]): string {
  const ordered = [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return createHash("sha256")
    .update(terminalSigningText("command", { kind: "offline_stock_timeline", batchId, entries: ordered }), "utf8")
    .digest("hex");
}
