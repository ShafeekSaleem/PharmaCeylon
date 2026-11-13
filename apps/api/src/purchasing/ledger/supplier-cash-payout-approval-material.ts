import type { Prisma, SupplierCashPayout } from "@prisma/client";
import { approvalMaterialDigest } from "../../security/approval-material-digest";

export type StoredPayoutAllocation = Readonly<{ invoiceId: string; amount: string }>;

export const storedAllocations = (doc: Pick<SupplierCashPayout, "allocations">) =>
  doc.allocations as unknown as StoredPayoutAllocation[];

/** Exact payment material: supplier, amount, date, allocations and references. */
export function supplierCashPayoutMaterial(
  doc: Pick<
    SupplierCashPayout,
    "supplierId" | "amount" | "paidOn" | "reference" | "notes" | "allocations" | "purchaseOrderId"
  >,
): Prisma.InputJsonObject {
  const items = storedAllocations(doc);
  return {
    supplierId: doc.supplierId,
    amount: doc.amount.toFixed(2),
    paidOn: doc.paidOn.toISOString().slice(0, 10),
    reference: doc.reference,
    notes: doc.notes,
    items,
    allocations: items as unknown as Prisma.InputJsonArray,
    purchaseOrderId: doc.purchaseOrderId,
  };
}

export const supplierCashPayoutApprovalReview = (
  doc: Parameters<typeof supplierCashPayoutMaterial>[0] & Pick<SupplierCashPayout, "approvalVersion">,
) => ({
  expectedVersion: doc.approvalVersion,
  expectedDigest: approvalMaterialDigest("supplier_cash_payout", supplierCashPayoutMaterial(doc)),
});
