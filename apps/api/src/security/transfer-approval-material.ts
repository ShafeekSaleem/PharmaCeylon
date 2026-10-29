import type { Prisma, Transfer, TransferItem } from "@prisma/client";
import { approvalMaterialDigest } from "./approval-material-digest";

/** What a transfer approval covers: route and exact lines. Pass items ordered by id. */
export function transferApprovalMaterial(
  doc: Pick<Transfer, "fromBranchId" | "toBranchId" | "expectedOn">,
  items: Array<Pick<TransferItem, "id" | "productId" | "batchId" | "qty">>,
): Prisma.InputJsonObject {
  return {
    fromBranchId: doc.fromBranchId,
    toBranchId: doc.toBranchId,
    expectedOn: doc.expectedOn?.toISOString() ?? null,
    items: items.map((l) => ({
      id: l.id,
      productId: l.productId,
      batchId: l.batchId,
      qty: l.qty,
    })),
  };
}

export const transferApprovalReview = (
  version: number,
  doc: Parameters<typeof transferApprovalMaterial>[0],
  items: Parameters<typeof transferApprovalMaterial>[1],
) => ({
  expectedVersion: version,
  expectedDigest: approvalMaterialDigest(
    "transfer",
    transferApprovalMaterial(doc, [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))),
  ),
});
