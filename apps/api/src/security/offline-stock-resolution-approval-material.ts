import type { OfflineStockResolution, Prisma } from "@prisma/client";
import {
  resolutionMaterial,
  type CaseLineFacts,
  type OtherCase,
  type SettlementLink,
} from "../stock-cases/stock-case-plan";
import { approvalMaterialDigest } from "./approval-material-digest";

type Db = Prisma.TransactionClient;
type Plan = Pick<OfflineStockResolution, "id" | "tenantId" | "branchId" | "caseId" | "kind" | "links" | "requestedAt">;

/** Locks one offline stock discrepancy case (FOR UPDATE). Always taken before its plans and batches. */
export async function lockOfflineStockCase(db: Db, tenantId: string, branchId: string, caseId: string) {
  await db.$queryRaw`SELECT id FROM offline_stock_discrepancy WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${caseId}::uuid FOR UPDATE`;
}

/**
 * Locks a resolution plan the way every path that touches one does: its case first, then the
 * plan (batch rows, when needed, come after). Null when the plan is not at this branch.
 */
export async function lockOfflineStockResolution(db: Db, tenantId: string, branchId: string, resolutionId: string) {
  const binding = await db.offlineStockResolution.findFirst({
    where: { tenantId, branchId, id: resolutionId },
    select: { caseId: true },
  });
  if (!binding) return null;
  await lockOfflineStockCase(db, tenantId, branchId, binding.caseId);
  await db.$queryRaw`SELECT id FROM offline_stock_resolution WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${resolutionId}::uuid FOR UPDATE`;
  return binding;
}

/**
 * P5 #51: what an offline stock resolution approval covers, read on the caller's client (inside
 * the execution transaction, after the case, plan and batch locks): the case's sale and lines,
 * the plan, and every other case holding one of its batches that is open or was resolved after
 * the plan was prepared.
 */
export async function offlineStockResolutionFacts(db: Db, plan: Plan) {
  return (await offlineStockResolutionFactsFor(db, [plan])).get(plan.id) ?? null;
}

/** The same facts for several plans of one branch, in two reads. Plans whose case is gone are left out. */
export async function offlineStockResolutionFactsFor(db: Db, plans: readonly Plan[]) {
  const out = new Map<string, NonNullable<ReturnType<typeof factsOf>>>();
  if (!plans.length) return out;
  const { tenantId, branchId } = plans[0]!;
  if (plans.some((plan) => plan.tenantId !== tenantId || plan.branchId !== branchId))
    throw new Error("Resolution facts are read for one branch at a time");
  const cases = await db.offlineStockDiscrepancy.findMany({
    where: { tenantId, branchId, id: { in: [...new Set(plans.map((plan) => plan.caseId))] } },
    select: { id: true, saleId: true, commandId: true, status: true, lines: { orderBy: { batchId: "asc" } } },
  });
  const batchIds = [...new Set(cases.flatMap((found) => found.lines.map((line) => line.batchId)))];
  const earliest = new Date(Math.min(...plans.map((plan) => plan.requestedAt.getTime())));
  const others = batchIds.length
    ? await db.offlineStockDiscrepancyLine.findMany({
        where: {
          tenantId,
          branchId,
          batchId: { in: batchIds },
          case: { tenantId, OR: [{ status: "open" }, { resolvedAt: { gte: earliest } }] },
        },
        select: { batchId: true, caseId: true, soldQuantity: true, case: { select: { status: true, resolvedAt: true } } },
      })
    : [];
  for (const plan of plans) {
    const found = cases.find((c) => c.id === plan.caseId);
    const facts = found ? factsOf(plan, found, others) : null;
    if (facts) out.set(plan.id, facts);
  }
  return out;
}

type CaseRow = {
  id: string;
  saleId: string;
  commandId: string;
  status: string;
  lines: Array<CaseLineFacts>;
};
type OtherLine = { batchId: string; caseId: string; soldQuantity: number; case: { status: string; resolvedAt: Date | null } };

function factsOf(plan: Plan, found: CaseRow, others: readonly OtherLine[]) {
  const lines: CaseLineFacts[] = found.lines.map((line) => ({
    batchId: line.batchId,
    productId: line.productId,
    soldQuantity: line.soldQuantity,
    availableQuantityAtSync: line.availableQuantityAtSync,
    shortfallQuantity: line.shortfallQuantity,
    reason: line.reason,
  }));
  const mine = new Set(lines.map((line) => line.batchId));
  const held = others.filter((o) => o.caseId !== plan.caseId && mine.has(o.batchId));
  // A case that resolved after this plan was prepared stays in, so its leaving changes nothing.
  const otherCases: OtherCase[] = held
    .filter((o) => o.case.status === "open" || (o.case.resolvedAt !== null && o.case.resolvedAt >= plan.requestedAt))
    .map((o) => ({ batchId: o.batchId, caseId: o.caseId, soldQuantity: o.soldQuantity }));
  const otherOpenCases = held
    .filter((o) => o.case.status === "open")
    .map((o) => ({ batchId: o.batchId, caseId: o.caseId, soldQuantity: o.soldQuantity }));
  const material = resolutionMaterial({
    caseId: found.id,
    saleId: found.saleId,
    commandId: found.commandId,
    kind: plan.kind,
    lines,
    links: plan.links as unknown as SettlementLink[],
    otherCases,
  });
  return { case: found, lines, otherCases, otherOpenCases, material };
}

export const offlineStockResolutionDigest = (material: Prisma.InputJsonObject) =>
  approvalMaterialDigest("offline_stock_resolution", material);
