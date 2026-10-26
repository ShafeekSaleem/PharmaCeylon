import { stocktakeApprovalMaterial } from "./stocktake-approval-material";
import { approvalMaterialDigest } from "./approval-material-digest";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ApprovalDocumentIdentity } from "@pharmaceylon/shared";
import { denied, uuid } from "../terminals/terminal-wire";

/** Exact domain actions, never a client's HTTP/effect/permission label. More adapters
 * are added with the mixed-handler split; no generic fallback is authorized.
 */
export const APPROVAL_ACTIONS = {
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
  if (policy.documentType === "stocktake") {
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
    material = {
      fromBranchId: doc.fromBranchId,
      toBranchId: doc.toBranchId,
      expectedOn: doc.expectedOn?.toISOString() ?? null,
      items: doc.items.map((l) => ({
        id: l.id,
        productId: l.productId,
        batchId: l.batchId,
        qty: l.qty,
      })),
    };
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
    material = {
      type: doc.type,
      customerName: doc.customerName,
      saleId: doc.saleId,
      supplierId: doc.supplierId,
      purchaseOrderId: doc.purchaseOrderId,
      goodsReceiptId: doc.goodsReceiptId,
      amount: doc.amount.toFixed(2),
      reason: doc.reason,
      reasonCode: doc.reasonCode,
      items: doc.items.map((l) => ({
        id: l.id,
        productId: l.productId,
        batchId: l.batchId,
        qty: l.qty,
        unitPrice: l.unitPrice.toFixed(2),
        disposition: l.disposition,
      })),
    };
  }
  if (!Array.isArray(material.items) || !material.items.length)
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
