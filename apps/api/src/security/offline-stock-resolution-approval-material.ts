import type { OfflineStockResolution, Prisma } from "@prisma/client";
import {
  resolutionMaterial,
  type CaseLineFacts,
  type OtherOpenCase,
  type SettlementLink,
} from "../stock-cases/stock-case-plan";
import { approvalMaterialDigest } from "./approval-material-digest";

type Db = Prisma.TransactionClient;
type Plan = Pick<OfflineStockResolution, "tenantId" | "branchId" | "caseId" | "kind" | "links">;

/**
 * P5 #51: what an offline stock resolution approval covers, read on the caller's client (inside
 * the execution transaction, after the case, plan and batch locks): the case's sale and lines,
 * the plan, and every other open case holding one of its batches.
 */
export async function offlineStockResolutionFacts(db: Db, plan: Plan) {
  const { tenantId, branchId, caseId } = plan;
  const found = await db.offlineStockDiscrepancy.findFirst({
    where: { tenantId, branchId, id: caseId },
    select: { id: true, saleId: true, commandId: true, status: true, lines: { orderBy: { batchId: "asc" } } },
  });
  if (!found) return null;
  const lines: CaseLineFacts[] = found.lines.map((line) => ({
    batchId: line.batchId,
    productId: line.productId,
    soldQuantity: line.soldQuantity,
    availableQuantityAtSync: line.availableQuantityAtSync,
    shortfallQuantity: line.shortfallQuantity,
    reason: line.reason,
  }));
  const others = await db.offlineStockDiscrepancyLine.findMany({
    where: {
      tenantId,
      branchId,
      batchId: { in: lines.map((line) => line.batchId) },
      caseId: { not: caseId },
      case: { tenantId, status: "open" },
    },
    select: { batchId: true, caseId: true, soldQuantity: true },
  });
  const otherOpenCases: OtherOpenCase[] = others.map((o) => ({ batchId: o.batchId, caseId: o.caseId, soldQuantity: o.soldQuantity }));
  const material = resolutionMaterial({
    caseId: found.id,
    saleId: found.saleId,
    commandId: found.commandId,
    kind: plan.kind,
    lines,
    links: plan.links as unknown as SettlementLink[],
    otherOpenCases,
  });
  return { case: found, lines, otherOpenCases, material };
}

export const offlineStockResolutionDigest = (material: Prisma.InputJsonObject) =>
  approvalMaterialDigest("offline_stock_resolution", material);
