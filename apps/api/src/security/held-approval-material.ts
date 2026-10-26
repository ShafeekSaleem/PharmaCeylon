import type { HeldAdjustment, HeldDelivery, Prisma } from "@prisma/client";
import { approvalMaterialDigest } from "./approval-material-digest";

export function heldAdjustmentMaterial(doc: HeldAdjustment): Prisma.InputJsonObject {
  return { productId: doc.productId, batchId: doc.batchId, kind: doc.kind, qty: doc.qty,
    value: doc.value.toFixed(2), payload: doc.payload as Prisma.InputJsonValue };
}

export function heldDeliveryMaterial(doc: HeldDelivery, poVersion: number): Prisma.InputJsonObject {
  return { purchaseOrderId: doc.purchaseOrderId, purchaseOrderVersion: poVersion,
    delivery: (doc.preparedPayload ?? doc.payload) as Prisma.InputJsonValue };
}

export const heldReview = (documentType: "held_adjustment" | "held_delivery", version: number, material: Prisma.InputJsonObject) =>
  ({ expectedVersion: version, expectedDigest: approvalMaterialDigest(documentType, material) });
