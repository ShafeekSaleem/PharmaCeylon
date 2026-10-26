import type { Prisma } from "@prisma/client";
import { approvalMaterialDigest } from "./approval-material-digest";

export type StocktakeApprovalRow = Prisma.StocktakeGetPayload<{
  include: { lines: true; snapshotLines: true; countEntries: true };
}>;

/** Used both for the displayed review and the locked approval/execution read.
 * Notes and posting counters are metadata; count, condition, baseline and counter
 * identity are material even when changed by a legacy or internal writer.
 */
export function stocktakeApprovalMaterial(doc: StocktakeApprovalRow) {
  const sort = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const material: Prisma.InputJsonObject = {
    scope: doc.scope,
    movementMode: doc.movementMode,
    countedBy: doc.countedBy,
    snapshotAt: doc.snapshotAt?.toISOString() ?? null,
    frozenAt: doc.frozenAt?.toISOString() ?? null,
    items: sort(doc.lines).map((line) => ({
      id: line.id,
      productId: line.productId,
      batchId: line.batchId,
      systemQty: line.systemQty,
      countedQty: line.countedQty,
      condition: line.condition,
      reviewReason: line.reviewReason,
      reviewResolution: line.reviewResolution,
    })),
    snapshots: sort(doc.snapshotLines).map((line) => ({
      id: line.id,
      lineId: line.lineId,
      productId: line.productId,
      batchId: line.batchId,
      snapshotQty: line.snapshotQty,
    })),
    counts: sort(doc.countEntries).map((entry) => ({
      id: entry.id,
      lineId: entry.lineId,
      countedBy: entry.countedBy,
      countedQty: entry.countedQty,
      condition: entry.condition,
      isRecount: entry.isRecount,
      countedAt: entry.countedAt.toISOString(),
    })),
  };
  return {
    material,
    digest: approvalMaterialDigest("stocktake", material),
    requesters: [...new Set([doc.countedBy, ...doc.countEntries.map((entry) => entry.countedBy)])],
  };
}
