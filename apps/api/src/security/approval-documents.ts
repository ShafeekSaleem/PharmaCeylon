import { stocktakeApprovalMaterial } from "./stocktake-approval-material";
import { approvalMaterialDigest } from "./approval-material-digest";
import { heldAdjustmentMaterial, heldDeliveryMaterial } from "./held-approval-material";
import { goodsReturnMaterial, preparedReceiptMaterial } from "./receiving-approval-material";
import { transferApprovalMaterial } from "./transfer-approval-material";
import { saleRefundMaterial } from "./sale-refund-approval-material";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ApprovalDocumentIdentity } from "@pharmaceylon/shared";
import { denied, uuid } from "../terminals/terminal-wire";

/** Exact domain actions, never a client's HTTP/effect/permission label. More adapters
 * are added with the mixed-handler split; no generic fallback is authorized.
 */
export const APPROVAL_ACTIONS = {
  "held_adjustment.post": {
    documentType: "held_adjustment", approvalPermission: "inventory.write_off",
    executionPermission: "inventory.write_off", operation: "POST /api/v1/inventory/held-adjustments/:id/post",
  },
  "held_delivery.post": {
    documentType: "held_delivery", approvalPermission: "purchasing.approve",
    executionPermission: "purchasing.receive", operation: "POST /api/v1/purchasing/held-deliveries/:id/post",
  },
  "stocktake.post": {
    documentType: "stocktake",
    approvalPermission: "stocktakes.review",
    executionPermission: "stocktakes.review",
    operation: "POST /api/v1/stocktakes/:id/post",
  },
  "purchase_order.receive": {
    documentType: "purchase_order",
    approvalPermission: "purchasing.approve",
    executionPermission: "purchasing.receive",
    operation: "POST /api/v1/purchasing/purchase-orders/receive",
  },
  "transfer.ship": {
    documentType: "transfer",
    approvalPermission: "transfers.approve",
    executionPermission: "transfers.manage",
    operation: "POST /api/v1/transfers/:id/ship",
  },
  "goods_return.complete": {
    documentType: "goods_return",
    approvalPermission: "returns.approve",
    executionPermission: "returns.process",
    operation: "POST /api/v1/returns/:id/complete",
  },
  "sale_refund.execute": {
    documentType: "sale_refund",
    approvalPermission: "returns.approve",
    executionPermission: "sales.refund",
    operation: "POST /api/v1/sales/refund-requests/:id/execute",
  },
  "prepared_receipt.post": {
    documentType: "prepared_receipt",
    approvalPermission: "purchasing.approve",
    executionPermission: "purchasing.receive",
    operation: "POST /api/v1/purchasing/prepared-receipts/:id/post",
  },
} as const;
export type ApprovalAction = keyof typeof APPROVAL_ACTIONS;
export function approvalAction(raw: string) {
  if (!Object.hasOwn(APPROVAL_ACTIONS, raw))
    throw new BadRequestException("Unknown approval action");
  return APPROVAL_ACTIONS[raw as ApprovalAction];
}

export type ApprovalDocument = {
  identity: ApprovalDocumentIdentity;
  material: Prisma.InputJsonObject;
  requesters: string[];
};

/** Lock BEFORE reading material lines, and keep that lock through execution.
 * Database line triggers serialize every material edit against the same parent lock.
 * Approval state, notes, and legitimate execution counters are not material content.
 */
export async function approvalDocument(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  action: ApprovalAction,
  documentId: string,
  use: "approval" | "execution",
): Promise<ApprovalDocument> {
  uuid(tenantId);
  uuid(branchId);
  uuid(documentId);
  const policy = approvalAction(action);
  let material: Prisma.InputJsonObject;
  let version: number;
  let requester: string;
  let requesters: string[] | undefined;
  if (policy.documentType === "held_adjustment") {
    await tx.$queryRaw`SELECT id FROM held_adjustment WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.heldAdjustment.findFirst({ where: { tenantId, branchId, id: documentId } });
    if (!doc || !(use === "execution" ? ["approved"] : ["awaiting_approval", "approved"]).includes(doc.status)) denied("APPROVAL_INVALID");
    version = doc.approvalVersion; requester = doc.requestedBy; material = heldAdjustmentMaterial(doc);
  } else if (policy.documentType === "held_delivery") {
    // Every delivery path locks its PO first, then the held request, including revocation.
    const binding = await tx.heldDelivery.findFirst({ where: { tenantId, branchId, id: documentId }, select: { purchaseOrderId: true } });
    if (!binding) denied("APPROVAL_INVALID");
    await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${binding.purchaseOrderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM held_delivery WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.heldDelivery.findFirst({ where: { tenantId, branchId, id: documentId }, include: { purchaseOrder: true } });
    if (!doc || doc.purchaseOrder.tenantId !== tenantId || doc.purchaseOrder.branchId !== branchId
      || !["issued", "partially_received"].includes(doc.purchaseOrder.status)
      || !(use === "execution" ? ["approved"] : ["awaiting_approval", "approved"]).includes(doc.status)) denied("APPROVAL_INVALID");
    version = doc.approvalVersion; requester = doc.requestedBy;
    material = heldDeliveryMaterial(doc, doc.purchaseOrder.approvalVersion);
  } else if (policy.documentType === "stocktake") {
    await tx.$queryRaw`SELECT id FROM stocktake WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.stocktake.findFirst({
      where: { tenantId, branchId, id: documentId },
      include: { lines: true, snapshotLines: true, countEntries: true },
    });
    if (!doc || !(use === "execution" ? ["approved"] : ["under_review", "approved"]).includes(doc.status))
      denied("APPROVAL_INVALID");
    if (!doc.lines.length || doc.lines.some(line => line.countedQty === null || line.status === "recount_requested"))
      denied("APPROVAL_INVALID");
    const content = stocktakeApprovalMaterial(doc);
    material = content.material;
    requesters = content.requesters;
    requester = doc.countedBy;
    version = doc.approvalVersion;
  } else if (policy.documentType === "purchase_order") {
    await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.purchaseOrder.findFirst({
      where: { tenantId, branchId, id: documentId },
      include: { items: { where: { tenantId }, orderBy: { id: "asc" } } },
    });
    if (!doc) denied("APPROVAL_INVALID");
    const allowed =
      use === "execution"
        ? ["issued", "partially_received"]
        : ["draft", "pending_approval", "issued", "partially_received"];
    if (!allowed.includes(doc.status)) denied("APPROVAL_INVALID");
    version = doc.approvalVersion;
    requester = doc.createdBy;
    material = {
      supplierId: doc.supplierId,
      shippingCharges: doc.shippingCharges.toFixed(2),
      paymentTermsDays: doc.paymentTermsDays,
      expectedOn: doc.expectedOn?.toISOString() ?? null,
      supplierReference: doc.supplierReference,
      priority: doc.priority,
      deliveryInstructions: doc.deliveryInstructions,
      items: doc.items.map((l) => ({
        id: l.id,
        productId: l.productId,
        orderedQty: l.orderedQty,
        unitCost: l.unitCost.toFixed(2),
        orderedPacks: l.orderedPacks,
        unitsPerPack: l.unitsPerPack,
        packCost: l.packCost?.toFixed(2) ?? null,
        discountPercent: l.discountPercent.toFixed(2),
        taxPercent: l.taxPercent.toFixed(2),
      })),
    };
  } else if (policy.documentType === "transfer") {
    await tx.$queryRaw`SELECT id FROM transfer WHERE tenant_id = ${tenantId}::uuid AND from_branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.transfer.findFirst({
      where: { tenantId, fromBranchId: branchId, id: documentId },
      include: { items: { where: { tenantId }, orderBy: { id: "asc" } } },
    });
    if (
      !doc ||
      !(
        use === "execution" ? ["approved"] : ["requested", "approved"]
      ).includes(doc.status)
    )
      denied("APPROVAL_INVALID");
    version = doc.approvalVersion;
    requester = doc.requestedBy;
    material = transferApprovalMaterial(doc, doc.items);
  } else if (policy.documentType === "sale_refund") {
    await tx.$queryRaw`SELECT id FROM sale_refund_request WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.saleRefundRequest.findFirst({ where: { tenantId, branchId, id: documentId } });
    if (!doc || !["prepared", "approved"].includes(doc.status)) denied("APPROVAL_INVALID");
    version = doc.approvalVersion;
    requester = doc.requestedBy;
    material = saleRefundMaterial(doc);
  } else if (policy.documentType === "prepared_receipt") {
    // Same order as every receiving path: the purchase order first, then the prepared receipt.
    const binding = await tx.preparedReceipt.findFirst({ where: { tenantId, branchId, id: documentId }, select: { purchaseOrderId: true } });
    if (!binding) denied("APPROVAL_INVALID");
    await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${binding.purchaseOrderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM prepared_receipt WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.preparedReceipt.findFirst({ where: { tenantId, branchId, id: documentId } });
    const po = await tx.purchaseOrder.findFirst({
      where: { tenantId, branchId, id: binding.purchaseOrderId },
      include: { items: { where: { tenantId }, orderBy: { id: "asc" } } },
    });
    if (!doc || !po || !["issued", "partially_received"].includes(po.status)
      || !(use === "execution" ? ["approved"] : ["draft", "approved"]).includes(doc.status)) denied("APPROVAL_INVALID");
    version = doc.approvalVersion; requester = doc.preparedBy;
    material = preparedReceiptMaterial(doc, po);
  } else {
    await tx.$queryRaw`SELECT id FROM goods_return WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.goodsReturn.findFirst({
      where: { tenantId, branchId, id: documentId },
      include: { items: { where: { tenantId }, orderBy: { id: "asc" } } },
    });
    if (
      !doc ||
      !(
        use === "execution"
          ? ["awaiting_logistics", "in_review"]
          : ["draft", "pending_approval", "awaiting_logistics", "in_review"]
      ).includes(doc.status)
    )
      denied("APPROVAL_INVALID");
    // Legacy customer returns cannot complete here; actual refunds use the POS workflow.
    if (doc.type !== "supplier") denied("APPROVAL_INVALID");
    version = doc.approvalVersion;
    requester = doc.requestedBy;
    material = goodsReturnMaterial(doc);
  }
  if (!["held_adjustment", "held_delivery", "prepared_receipt"].includes(policy.documentType) && (!Array.isArray(material.items) || !material.items.length))
    denied("APPROVAL_INVALID");
  return {
    identity: {
      tenantId,
      branchId,
      documentType: policy.documentType,
      documentId,
      documentVersion: version,
      documentDigest: approvalMaterialDigest(policy.documentType, material),
      requestedByUserId: requester,
    },
    material,
    requesters: requesters ?? [requester],
  };
}
