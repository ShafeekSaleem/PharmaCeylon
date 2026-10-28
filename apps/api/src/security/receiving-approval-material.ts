import type { GoodsReturn, GoodsReturnItem, Prisma, PreparedReceipt, PurchaseOrderItem } from "@prisma/client";
import { approvalMaterialDigest } from "./approval-material-digest";

/** What a supplier-return approval binds: the header and every line, never notes or status. */
export function goodsReturnMaterial(doc: GoodsReturn & { items: GoodsReturnItem[] }): Prisma.InputJsonObject {
  return {
    type: doc.type,
    customerName: doc.customerName,
    saleId: doc.saleId,
    supplierId: doc.supplierId,
    purchaseOrderId: doc.purchaseOrderId,
    goodsReceiptId: doc.goodsReceiptId,
    amount: doc.amount.toFixed(2),
    reason: doc.reason,
    reasonCode: doc.reasonCode,
    items: [...doc.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((l) => ({
      id: l.id,
      productId: l.productId,
      batchId: l.batchId,
      qty: l.qty,
      unitPrice: l.unitPrice.toFixed(2),
      disposition: l.disposition,
    })),
  };
}

/** A prepared receipt is approved against the order as it stood: its material revision and
 * what had already been received on each line. A delivery booked in between, or an order edit,
 * makes the approval stale rather than letting the same goods be counted twice.
 */
export function preparedReceiptMaterial(
  doc: PreparedReceipt,
  po: { approvalVersion: number; items: Pick<PurchaseOrderItem, "id" | "receivedQty" | "freeQty" | "rejectedQty">[] },
): Prisma.InputJsonObject {
  return {
    purchaseOrderId: doc.purchaseOrderId,
    purchaseOrderVersion: po.approvalVersion,
    received: [...po.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((l) => ({
      id: l.id, receivedQty: l.receivedQty, freeQty: l.freeQty, rejectedQty: l.rejectedQty,
    })),
    delivery: doc.payload as Prisma.InputJsonValue,
  };
}

export const documentReview = (documentType: string, version: number, material: Prisma.InputJsonObject) =>
  ({ expectedVersion: version, expectedDigest: approvalMaterialDigest(documentType, material) });
