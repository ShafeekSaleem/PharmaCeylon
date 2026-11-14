import { Injectable } from "@nestjs/common";
import {
  GoodsReturnStatus,
  GoodsReturnType,
  HeldAdjustmentStatus,
  HeldDeliveryStatus,
  PreparedReceiptStatus,
  type Prisma,
  StocktakeStatus,
  TransferStatus,
} from "@prisma/client";
import {
  type CounterWorkKind,
  type CounterWorkTask,
  type HeldAdjustmentCounterStatus,
  COUNTER_REJECTED_HELD_WRITE_OFF_VISIBLE_DAYS,
  COUNTER_WORK_OPERATION,
  projectCounterWorkTask,
} from "@pharmaceylon/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RefundRequestsService } from "../sales/refund-requests.service";
import { AccessService } from "../security/access.service";
import { approvalMaterialDigest } from "../security/approval-material-digest";
import { heldAdjustmentMaterial, heldDeliveryMaterial } from "../security/held-approval-material";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { goodsReturnMaterial, preparedReceiptMaterial } from "../security/receiving-approval-material";
import { saleRefundMaterial } from "../security/sale-refund-approval-material";
import { stocktakeApprovalMaterial } from "../security/stocktake-approval-material";
import { transferApprovalMaterial } from "../security/transfer-approval-material";
import { describeMaterialChanges } from "./counter-work-changes";
import { StockCasesService } from "../stock-cases/stock-cases.service";
import {
  storedAllocations,
  supplierCashPayoutMaterial,
} from "../purchasing/ledger/supplier-cash-payout-approval-material";
import { SupplierCashPayoutStatus } from "@prisma/client";

export type { CounterWorkKind };

type Person = { name: string | null; at: string | null };

/**
 * One piece of web-approved work waiting at this branch's counter. The same header fields for
 * every kind, so the counter can show who asked, who approved which version, and whether the
 * document still matches that approval before anyone executes it.
 */
export type CounterWorkItem = {
  kind: CounterWorkKind;
  id: string;
  /** The document's own number (PO, transfer, refund request, stocktake, return) or file name. */
  reference: string;
  /** Who or where it concerns: the supplier, the other branch, the sale, the product. */
  subject: string | null;
  lineCount: number;
  /** Null when the caller may not see costs, or the kind carries no amount. */
  amount: string | null;
  /** When it became ready at the counter (approved, dispatched or staged). */
  readyAt: string;
  requested: Person | null;
  approved: Person | null;
  /** Transfers in: who sent it from the other branch. */
  dispatched: Person | null;
  approval: {
    evidenceId: string | null;
    approvedVersion: number | null;
    currentVersion: number | null;
    /**
     * matches: the document is exactly what was approved. changed: it moved since approval and
     * the counter will be refused until it is approved again. revoked: the approval was
     * withdrawn. not_needed: policy waived approval, or the kind has none.
     */
    state: "matches" | "changed" | "revoked" | "not_needed";
    /** What moved since approval, in words, when state is "changed". */
    changes: string[];
  };
  /** The signed operation that executes it at the counter. */
  operation: (typeof COUNTER_WORK_OPERATION)[CounterWorkKind];
  /** W11/P6 task state, next action, blocker, freshness and destination (#172). */
  task: CounterWorkTask;
  /** Held write-off lifecycle for read-only counter rows (#173). */
  heldAdjustmentStatus?: HeldAdjustmentCounterStatus;
};

type CounterWorkItemCore = Omit<CounterWorkItem, "task"> & {
  heldAdjustmentStatus?: HeldAdjustmentCounterStatus;
};

/** Each kind is listed only to someone who may execute it here (the operation's own permission). */
const EXECUTE_PERMISSION: Record<CounterWorkKind, string> = {
  prepared_receipt: "purchasing.receive",
  held_delivery: "purchasing.receive",
  transfer_ship: "transfers.manage",
  transfer_receive: "transfers.manage",
  refund: "sales.refund",
  stocktake: "stocktakes.review",
  held_adjustment: "inventory.write_off",
  supplier_return: "returns.process",
  import_stock: "products.import",
  // P5 #51: count, correct and post an offline sale's stock, as approved on the web.
  stock_case: "inventory.manage",
  supplier_cash_payout: "suppliers.pay",
};

const RECEIVABLE_PO = ["issued", "partially_received"] as const;
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const money = (value: Prisma.Decimal | number) =>
  (typeof value === "number" ? value : Number(value.toFixed(2))).toFixed(2);

type Evidence = {
  id: string;
  documentVersion: number;
  documentDigest: string;
  material: Prisma.JsonValue;
  revokedAt: Date | null;
  approvedByUserId: string;
  approvedAt: Date;
};

function approvalState(
  documentType: string,
  evidence: Evidence | undefined,
  currentVersion: number,
  current: () => Prisma.InputJsonObject,
): CounterWorkItem["approval"] {
  if (!evidence)
    return { evidenceId: null, approvedVersion: null, currentVersion, state: "not_needed", changes: [] };
  const base = { evidenceId: evidence.id, approvedVersion: evidence.documentVersion, currentVersion };
  if (evidence.revokedAt) return { ...base, state: "revoked", changes: [] };
  const material = current();
  if (
    evidence.documentVersion === currentVersion &&
    approvalMaterialDigest(documentType, material) === evidence.documentDigest
  )
    return { ...base, state: "matches", changes: [] };
  return { ...base, state: "changed", changes: describeMaterialChanges(evidence.material, material) };
}

/**
 * Read-only: what web-approved work is waiting at this branch for the counter to execute. It
 * projects the existing documents (no aggregate model) and answers the same "ready" questions
 * their own screens and execution paths ask.
 */
@Injectable()
export class CounterWorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly refunds: RefundRequestsService,
    private readonly stockCases?: StockCasesService,
  ) {}

  async list(user: RequestUser, branchId: string, asOf = new Date().toISOString()): Promise<CounterWorkItem[]> {
    const access = await this.access.resolve(user, branchId);
    const may = (kind: CounterWorkKind) => access.has(EXECUTE_PERMISSION[kind]);
    const costs = access.has("costs.view");
    const { tenantId } = user;
    const parts = await Promise.all([
      may("prepared_receipt") ? this.preparedReceipts(tenantId, branchId, costs) : [],
      may("held_delivery") ? this.heldDeliveries(tenantId, branchId, costs) : [],
      may("transfer_ship") ? this.transfersOut(tenantId, branchId) : [],
      may("transfer_receive") ? this.transfersIn(tenantId, branchId) : [],
      may("refund") ? this.refundRequests(tenantId, branchId) : [],
      may("stocktake") ? this.stocktakes(tenantId, branchId) : [],
      may("held_adjustment") ? this.heldAdjustments(tenantId, branchId, costs) : [],
      may("supplier_return") ? this.supplierReturns(tenantId, branchId, costs) : [],
      may("import_stock") ? this.stagedImports(tenantId, branchId) : [],
      may("stock_case") && this.stockCases ? this.stockCasePlans(tenantId, branchId) : [],
      may("supplier_cash_payout") ? this.supplierCashPayouts(tenantId, branchId) : [],
    ]);
    const rows = parts.flat();
    await this.name(tenantId, rows);
    const items: CounterWorkItem[] = [];
    for (const row of rows) {
      const task = projectCounterWorkTask({
        kind: row.kind,
        id: row.id,
        approval: row.approval,
        approvedAt: row.approved?.at ?? null,
        readyAt: row.readyAt,
        asOf,
        heldAdjustmentStatus: row.heldAdjustmentStatus,
      });
      items.push({
        ...row,
        operation: COUNTER_WORK_OPERATION[row.kind],
        task,
        ...(row.heldAdjustmentStatus ? { heldAdjustmentStatus: row.heldAdjustmentStatus } : {}),
      });
    }
    return items.sort((a, b) => b.readyAt.localeCompare(a.readyAt));
  }

  /** Fills in people's names in one read; until then `name` carries the user id. */
  private async name(tenantId: string, items: CounterWorkItemCore[]) {
    const people = items.flatMap((item) => [item.requested, item.approved, item.dispatched]);
    const ids = [...new Set(people.map((p) => p?.name).filter((id): id is string => !!id))];
    if (!ids.length) return;
    const users = await this.prisma.appUser.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, fullName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u.fullName]));
    for (const person of people) if (person?.name) person.name = byId.get(person.name) ?? null;
  }

  private async evidence(tenantId: string, branchId: string, ids: (string | null)[]) {
    const wanted = ids.filter((id): id is string => !!id);
    const rows = wanted.length
      ? await this.prisma.managementApproval.findMany({
          where: { tenantId, branchId, id: { in: wanted } },
          select: {
            id: true, documentVersion: true, documentDigest: true, material: true, revokedAt: true,
            approvedByUserId: true, approvedAt: true,
          },
        })
      : [];
    return new Map<string, Evidence>(rows.map((row) => [row.id, row]));
  }

  private approver(evidence: Evidence | undefined, fallbackId: string | null, fallbackAt: Date | null): Person | null {
    if (evidence) return { name: evidence.approvedByUserId, at: iso(evidence.approvedAt) };
    return fallbackId ? { name: fallbackId, at: iso(fallbackAt) } : null;
  }

  private async preparedReceipts(tenantId: string, branchId: string, costs: boolean) {
    const rows = await this.prisma.preparedReceipt.findMany({
      where: {
        tenantId, branchId, status: PreparedReceiptStatus.approved, executionApprovalId: { not: null },
        purchaseOrder: { status: { in: [...RECEIVABLE_PO] } },
      },
      include: {
        purchaseOrder: {
          include: { supplier: { select: { name: true } }, items: { where: { tenantId }, orderBy: { id: "asc" } } },
        },
      },
    });
    const evidence = await this.evidence(tenantId, branchId, rows.map((r) => r.executionApprovalId));
    return rows.map((row): CounterWorkItemCore => {
      const ev = evidence.get(row.executionApprovalId!);
      const lines = deliveryLines(row.payload);
      return {
        kind: "prepared_receipt",
        id: row.id,
        reference: row.purchaseOrder.poNumber,
        subject: row.purchaseOrder.supplier?.name ?? null,
        lineCount: lines.length,
        amount: costs ? deliveryAmount(lines) : null,
        readyAt: (row.approvedAt ?? row.preparedAt).toISOString(),
        requested: { name: row.preparedBy, at: iso(row.preparedAt) },
        approved: this.approver(ev, row.approvedBy, row.approvedAt),
        dispatched: null,
        approval: approvalState("prepared_receipt", ev, row.approvalVersion,
          () => preparedReceiptMaterial(row, row.purchaseOrder)),
        operation: "POST /api/v1/purchasing/prepared-receipts/:id/post",
      };
    });
  }

  private async heldDeliveries(tenantId: string, branchId: string, costs: boolean) {
    const rows = await this.prisma.heldDelivery.findMany({
      where: {
        tenantId, branchId, status: HeldDeliveryStatus.approved, executionApprovalId: { not: null },
        purchaseOrder: { status: { in: [...RECEIVABLE_PO] } },
      },
      include: { purchaseOrder: { include: { supplier: { select: { name: true } } } } },
    });
    const evidence = await this.evidence(tenantId, branchId, rows.map((r) => r.executionApprovalId));
    return rows.map((row): CounterWorkItemCore => {
      const ev = evidence.get(row.executionApprovalId!);
      const lines = deliveryLines(row.preparedPayload ?? row.payload);
      return {
        kind: "held_delivery",
        id: row.id,
        reference: row.purchaseOrder.poNumber,
        subject: row.purchaseOrder.supplier?.name ?? null,
        lineCount: lines.length,
        amount: costs ? deliveryAmount(lines) : null,
        readyAt: (row.decidedAt ?? row.requestedAt).toISOString(),
        requested: { name: row.requestedBy, at: iso(row.requestedAt) },
        approved: this.approver(ev, row.decidedBy, row.decidedAt),
        dispatched: null,
        approval: approvalState("held_delivery", ev, row.approvalVersion,
          () => heldDeliveryMaterial(row, row.purchaseOrder.approvalVersion)),
        operation: "POST /api/v1/purchasing/held-deliveries/:id/post",
      };
    });
  }

  /** Approved to leave this branch: with its approval, or with approval waived by tenant policy. */
  private async transfersOut(tenantId: string, branchId: string) {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { approvalRequiredForBranchTransfers: true },
    });
    const approvalRequired = settings?.approvalRequiredForBranchTransfers ?? true;
    const rows = await this.prisma.transfer.findMany({
      where: {
        tenantId, fromBranchId: branchId, status: TransferStatus.approved,
        ...(approvalRequired ? { executionApprovalId: { not: null } } : {}),
      },
      include: { toBranch: { select: { name: true } }, items: { where: { tenantId }, orderBy: { id: "asc" } } },
    });
    const evidence = await this.evidence(tenantId, branchId, rows.map((r) => r.executionApprovalId));
    return rows.map((row): CounterWorkItemCore => {
      const ev = row.executionApprovalId ? evidence.get(row.executionApprovalId) : undefined;
      return {
        kind: "transfer_ship",
        id: row.id,
        reference: row.transferNumber,
        subject: row.toBranch.name,
        lineCount: row.items.length,
        amount: null,
        readyAt: (row.approvedAt ?? row.createdAt).toISOString(),
        requested: { name: row.requestedBy, at: iso(row.createdAt) },
        approved: this.approver(ev, row.approvedBy, row.approvedAt),
        dispatched: null,
        approval: approvalState("transfer", ev, row.approvalVersion,
          () => transferApprovalMaterial(row, row.items)),
        operation: "POST /api/v1/transfers/:id/ship",
      };
    });
  }

  /** On the way here. The dispatch approval was the source branch's; nothing changes it now. */
  private async transfersIn(tenantId: string, branchId: string) {
    const rows = await this.prisma.transfer.findMany({
      where: {
        tenantId, toBranchId: branchId,
        status: { in: [TransferStatus.in_transit, TransferStatus.partially_received] },
      },
      include: { fromBranch: { select: { name: true } }, items: { where: { tenantId } } },
    });
    return rows.map((row): CounterWorkItemCore => ({
      kind: "transfer_receive",
      id: row.id,
      reference: row.transferNumber,
      subject: row.fromBranch.name,
      lineCount: row.items.length,
      amount: null,
      readyAt: (row.dispatchedAt ?? row.updatedAt).toISOString(),
      requested: { name: row.requestedBy, at: iso(row.createdAt) },
      approved: row.approvedBy ? { name: row.approvedBy, at: iso(row.approvedAt) } : null,
      dispatched: row.dispatchedBy ? { name: row.dispatchedBy, at: iso(row.dispatchedAt) } : null,
      approval: {
        evidenceId: row.executionApprovalId,
        approvedVersion: null,
        currentVersion: row.approvalVersion,
        state: row.executionApprovalId ? "matches" : "not_needed",
        changes: [],
      },
      operation: "POST /api/v1/transfers/:id/receive",
    }));
  }

  private async supplierCashPayouts(tenantId: string, branchId: string) {
    const rows = await this.prisma.supplierCashPayout.findMany({
      where: { tenantId, branchId, status: SupplierCashPayoutStatus.approved, executionApprovalId: { not: null } },
    });
    if (!rows.length) return [];
    const evidence = await this.evidence(tenantId, branchId, rows.map((r) => r.executionApprovalId));
    const suppliers = await this.prisma.supplier.findMany({
      where: { tenantId, id: { in: rows.map((r) => r.supplierId) } },
      select: { id: true, name: true },
    });
    return rows.map((row): CounterWorkItemCore => {
      const ev = evidence.get(row.executionApprovalId!);
      const supplierName = suppliers.find((s) => s.id === row.supplierId)?.name ?? null;
      return {
        kind: "supplier_cash_payout",
        id: row.id,
        reference: row.payoutNumber,
        subject: supplierName,
        lineCount: Math.max(storedAllocations(row).length, 1),
        amount: money(row.amount),
        readyAt: (row.approvedAt ?? row.requestedAt).toISOString(),
        requested: { name: row.requestedBy, at: iso(row.requestedAt) },
        approved: this.approver(ev, row.approvedBy, row.approvedAt),
        dispatched: null,
        approval: approvalState("supplier_cash_payout", ev, row.approvalVersion, () => supplierCashPayoutMaterial(row)),
        operation: "POST /api/v1/purchasing/cash-payouts/:id/execute",
      };
    });
  }

  /** The refund requests' own "ready at the counter" answer, plus ones whose approval was withdrawn. */
  private async refundRequests(tenantId: string, branchId: string) {
    const listed = (await this.refunds.list(tenantId, branchId, {})).filter(
      (r) => r.readyAtCounter || ((r.status === "prepared" || r.status === "approved") && r.approvalRevoked),
    );
    if (!listed.length) return [];
    const [rows, evidence] = await Promise.all([
      this.prisma.saleRefundRequest.findMany({ where: { tenantId, branchId, id: { in: listed.map((r) => r.id) } } }),
      this.evidence(tenantId, branchId, listed.map((r) => r.executionApprovalId)),
    ]);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    return listed.map((r): CounterWorkItemCore => {
      const row = rowById.get(r.id)!;
      const ev = r.executionApprovalId ? evidence.get(r.executionApprovalId) : undefined;
      return {
        kind: "refund",
        id: r.id,
        reference: r.requestNumber,
        subject: r.invoiceNo,
        lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
        amount: r.amount,
        readyAt: r.approvedAt ?? r.requestedAt,
        requested: { name: row.requestedBy, at: r.requestedAt },
        approved: this.approver(ev, row.approvedBy, row.approvedAt),
        dispatched: null,
        approval: approvalState("sale_refund", ev, row.approvalVersion, () => saleRefundMaterial(row)),
        operation: "POST /api/v1/sales/refund-requests/:id/execute",
      };
    });
  }

  private async stocktakes(tenantId: string, branchId: string) {
    const rows = await this.prisma.stocktake.findMany({
      where: { tenantId, branchId, status: StocktakeStatus.approved, executionApprovalId: { not: null } },
      include: { lines: true, snapshotLines: true, countEntries: true },
    });
    const evidence = await this.evidence(tenantId, branchId, rows.map((r) => r.executionApprovalId));
    return rows.map((row): CounterWorkItemCore => {
      const ev = evidence.get(row.executionApprovalId!);
      return {
        kind: "stocktake",
        id: row.id,
        reference: row.stocktakeNumber,
        subject: row.title ?? row.areaLabel,
        lineCount: row.lines.length,
        amount: null,
        readyAt: (row.approvedAt ?? row.updatedAt).toISOString(),
        requested: { name: row.countedBy, at: iso(row.submittedAt ?? row.createdAt) },
        approved: this.approver(ev, row.approvedBy, row.approvedAt),
        dispatched: null,
        approval: approvalState("stocktake", ev, row.approvalVersion, () => stocktakeApprovalMaterial(row).material),
        operation: "POST /api/v1/stocktakes/:id/post",
      };
    });
  }

  private async heldAdjustments(tenantId: string, branchId: string, costs: boolean) {
    const rejectedSince = new Date(
      Date.now() - COUNTER_REJECTED_HELD_WRITE_OFF_VISIBLE_DAYS * 86_400_000,
    );
    const rows = await this.prisma.heldAdjustment.findMany({
      where: {
        tenantId,
        branchId,
        OR: [
          {
            status: HeldAdjustmentStatus.approved,
            executionApprovalId: { not: null },
          },
          { status: HeldAdjustmentStatus.awaiting_approval },
          {
            status: HeldAdjustmentStatus.rejected,
            OR: [
              { decidedAt: { gte: rejectedSince } },
              { decidedAt: null, requestedAt: { gte: rejectedSince } },
            ],
          },
        ],
      },
      include: { product: { select: { name: true } }, batch: { select: { batchNo: true } } },
    });
    const evidence = await this.evidence(
      tenantId,
      branchId,
      rows.map((r) => r.executionApprovalId),
    );
    return rows.map((row): CounterWorkItemCore => {
      const readOnly =
        row.status === HeldAdjustmentStatus.awaiting_approval ||
        row.status === HeldAdjustmentStatus.rejected;
      const ev = row.executionApprovalId ? evidence.get(row.executionApprovalId) : undefined;
      const heldAdjustmentStatus = row.status as HeldAdjustmentCounterStatus;
      return {
        kind: "held_adjustment",
        id: row.id,
        reference: row.batch.batchNo,
        subject: row.product.name,
        lineCount: 1,
        amount: costs ? money(row.value) : null,
        readyAt: (row.decidedAt ?? row.requestedAt).toISOString(),
        requested: { name: row.requestedBy, at: iso(row.requestedAt) },
        approved: readOnly ? null : this.approver(ev, row.decidedBy, row.decidedAt),
        dispatched: null,
        approval: readOnly
          ? {
              evidenceId: null,
              approvedVersion: null,
              currentVersion: row.approvalVersion,
              state: "not_needed",
              changes: [],
            }
          : approvalState("held_adjustment", ev, row.approvalVersion, () => heldAdjustmentMaterial(row)),
        operation: "POST /api/v1/inventory/held-adjustments/:id/post",
        heldAdjustmentStatus,
      };
    });
  }

  /** Approved supplier returns waiting to go out; the latest approval is the one completion uses. */
  private async supplierReturns(tenantId: string, branchId: string, costs: boolean) {
    const rows = await this.prisma.goodsReturn.findMany({
      where: {
        tenantId, branchId, type: GoodsReturnType.supplier,
        status: { in: [GoodsReturnStatus.awaiting_logistics, GoodsReturnStatus.in_review] },
      },
      include: { supplier: { select: { name: true } }, items: { where: { tenantId }, orderBy: { id: "asc" } } },
    });
    if (!rows.length) return [];
    const approvals = await this.prisma.managementApproval.findMany({
      where: {
        tenantId, branchId, documentType: "goods_return", authorizedAction: "goods_return.complete",
        documentId: { in: rows.map((r) => r.id) },
      },
      orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
      select: {
        id: true, documentId: true, documentVersion: true, documentDigest: true, material: true, revokedAt: true,
        approvedByUserId: true, approvedAt: true,
      },
    });
    const latest = new Map<string, Evidence>();
    for (const row of approvals) if (!latest.has(row.documentId)) latest.set(row.documentId, row);
    return rows
      .filter((row) => latest.has(row.id))
      .map((row): CounterWorkItemCore => {
        const ev = latest.get(row.id)!;
        return {
          kind: "supplier_return",
          id: row.id,
          reference: row.returnNumber,
          subject: row.supplier?.name ?? null,
          lineCount: row.items.length,
          amount: costs ? money(row.amount) : null,
          readyAt: ev.approvedAt.toISOString(),
          requested: { name: row.requestedBy, at: iso(row.createdAt) },
          approved: this.approver(ev, null, null),
          dispatched: null,
          approval: approvalState("goods_return", ev, row.approvalVersion, () => goodsReturnMaterial(row)),
          operation: "POST /api/v1/returns/:id/complete",
        };
      });
  }

  /**
   * P5 #51: approved plans for offline stock cases. "changed" when another case has since opened
   * on one of its batches (the approved content includes them), "revoked" when withdrawn.
   */
  private async stockCasePlans(tenantId: string, branchId: string) {
    const plans = await this.stockCases!.readyAtCounter(tenantId, branchId);
    if (!plans.length) return [];
    const rows = await this.prisma.offlineStockResolution.findMany({
      where: { tenantId, branchId, id: { in: plans.map((p) => p.resolutionId) } },
      select: { id: true, requestedBy: true, approvedBy: true },
    });
    return plans.map((plan): CounterWorkItemCore => {
      const row = rows.find((r) => r.id === plan.resolutionId)!;
      return {
        kind: "stock_case",
        id: plan.resolutionId,
        reference: plan.invoiceNo,
        subject: plan.lines.map((line) => line.productName).join(", ") || null,
        lineCount: plan.lines.length,
        amount: null,
        readyAt: plan.approvedAt ?? plan.requestedAt,
        requested: { name: row.requestedBy, at: plan.requestedAt },
        approved: row.approvedBy ? { name: row.approvedBy, at: plan.approvedAt } : null,
        dispatched: null,
        approval: {
          evidenceId: plan.approvalEvidenceId,
          approvedVersion: plan.approvalVersion,
          currentVersion: plan.approvalVersion,
          state: plan.approvalState === "matches" ? "matches" : plan.approvalState === "revoked" ? "revoked" : "changed",
          changes: plan.approvalState === "changed" ? ["Another offline sale now waits on one of these batches"] : [],
        },
        operation: "POST /api/v1/offline-stock-cases/resolutions/:id/execute",
      };
    });
  }

  /** Opening stock staged from an import and not posted yet. It needs no approval. */
  private async stagedImports(tenantId: string, branchId: string) {
    const rows = await this.prisma.productImport.findMany({
      where: { tenantId, branchId, status: "completed", stockStaged: true, stockPostedAt: null },
      select: {
        id: true, filename: true, stagedStock: true, stockVersion: true, stockStagedBy: true,
        createdBy: true, createdAt: true, completedAt: true,
      },
    });
    return rows.map((row): CounterWorkItemCore => ({
      kind: "import_stock",
      id: row.id,
      reference: row.filename,
      subject: null,
      lineCount: Array.isArray(row.stagedStock) ? row.stagedStock.length : 0,
      amount: null,
      readyAt: (row.completedAt ?? row.createdAt).toISOString(),
      requested: { name: row.stockStagedBy ?? row.createdBy, at: iso(row.completedAt ?? row.createdAt) },
      approved: null,
      dispatched: null,
      approval: {
        evidenceId: null, approvedVersion: null, currentVersion: row.stockVersion, state: "not_needed", changes: [],
      },
      operation: "POST /api/v1/products/import/:importId/stock/post",
    }));
  }
}

type DeliveryLine = { receivedQty?: number; packs?: number; unitsPerPack?: number; costPrice?: string; packCost?: string };

function deliveryLines(payload: Prisma.JsonValue): DeliveryLine[] {
  const lines = (payload as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? (lines as DeliveryLine[]) : [];
}

/** What the delivery is billed at: packs × pack cost, or units × unit cost. Free goods are not billed. */
function deliveryAmount(lines: DeliveryLine[]): string | null {
  let total = 0;
  for (const line of lines) {
    if (line.packs != null && line.packCost != null) total += line.packs * Number(line.packCost);
    else if (line.receivedQty != null && line.costPrice != null) total += line.receivedQty * Number(line.costPrice);
    else return null;
  }
  return total.toFixed(2);
}
