import type { Prisma, SaleRefundRequest } from "@prisma/client";
import { approvalMaterialDigest } from "./approval-material-digest";

/** What a refund approval covers: the sale, the priced lines, the amount, how and why. */
export function saleRefundMaterial(
  doc: Pick<SaleRefundRequest, "saleId" | "lines" | "amount" | "refundMethod" | "reasonCode" | "reason">,
): Prisma.InputJsonObject {
  return {
    saleId: doc.saleId,
    items: doc.lines as Prisma.InputJsonArray,
    amount: doc.amount.toFixed(2),
    refundMethod: doc.refundMethod,
    reasonCode: doc.reasonCode,
    reason: doc.reason,
  };
}

export const saleRefundApprovalReview = (
  doc: Parameters<typeof saleRefundMaterial>[0] & Pick<SaleRefundRequest, "approvalVersion">,
) => ({
  expectedVersion: doc.approvalVersion,
  expectedDigest: approvalMaterialDigest("sale_refund", saleRefundMaterial(doc)),
});
