import type {
  CashPayoutAtCounter,
  CashPayoutExecuted,
  CounterWorkItem,
  HeldWriteOffAtCounter,
  RefundAtCounter,
  RefundExecuted,
  StockCaseAtCounter,
  StockCaseResolved,
} from "../../shared/ipc-contract";
import type { SupplierCashPayoutView } from "@pharmaceylon/shared";
import { ApiError, type ApiSession } from "../api/api-client";
import { ActionFailure, type TerminalService } from "./terminal-service";
import type { SignedCommandService } from "./signed-commands";

type RawRefundRequest = {
  id: string;
  requestNumber: string;
  invoiceNo: string | null;
  amount: string;
  refundMethod: string | null;
  reason: string;
  executionApprovalId: string | null;
  readyAtCounter: boolean;
  requester: { id: string; fullName: string } | null;
  approver: { id: string; fullName: string } | null;
  approvalRequired: boolean;
  requestedAt?: string;
  approvedAt?: string | null;
};

/**
 * Work prepared and approved remotely that only the counter may execute (revised D10). The list
 * shows who asked and who approved; executing records the signed-in person as the executor.
 */
export class CounterWorkService {
  constructor(
    private readonly deps: {
      api: ApiSession;
      terminal: TerminalService;
      commands: SignedCommandService;
    },
  ) {}

  private branchId() {
    const current = this.deps.terminal.current();
    if (!current)
      throw new ActionFailure(
        "NOT_SIGNED_IN",
        "Sign in at this counter first.",
      );
    return current.identity.branchId;
  }

  /**
   * Everything approved on the web and waiting here, each with who asked, who approved which
   * version and whether it still matches. Someone the server won't show counter work to (no
   * `terminal.execute`) has nothing waiting. A server from before `GET /counter-work` still
   * lists its refunds, so refund execution keeps working through an upgrade.
   */
  async list(): Promise<CounterWorkItem[]> {
    const branchId = this.branchId();
    let items: CounterWorkItem[] = [];
    try {
      items = await this.deps.api.request<CounterWorkItem[]>(
        "GET",
        "/counter-work",
        { branchId },
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 403) items = [];
      else if (error.status === 404) {
        items = (await this.readyRefunds(branchId)).map(
          (r): CounterWorkItem => ({
            kind: "refund",
            id: r.id,
            reference: r.requestNumber,
            subject: r.invoiceNo,
            lineCount: 0,
            amount: r.amount,
            readyAt: r.approvedAt ?? r.requestedAt ?? new Date(0).toISOString(),
            requested: r.requester
              ? { name: r.requester.fullName, at: r.requestedAt ?? null }
              : null,
            approved: r.approver
              ? { name: r.approver.fullName, at: r.approvedAt ?? null }
              : null,
            dispatched: null,
            approval: {
              evidenceId: r.executionApprovalId,
              approvedVersion: null,
              currentVersion: null,
              state: r.executionApprovalId ? "matches" : "not_needed",
              changes: [],
            },
          }),
        );
      } else throw error;
    }
    const supplement = await this.heldWriteOffRows();
    return this.mergeHeldWriteOffs(items, supplement);
  }

  /** All held write-off rows the counter may read (for detail panes and post pin). */
  async heldWriteOffsAtCounter(): Promise<HeldWriteOffAtCounter[]> {
    return this.heldWriteOffRows();
  }

  async postHeldWriteOff(
    heldAdjustmentId: string,
    approvalEvidenceId: string | null,
  ): Promise<{
    heldAdjustmentId: string;
    stockReferenceId: string;
    alreadyApplied: boolean;
  }> {
    const rows = await this.heldWriteOffRows();
    const row = rows.find((r) => r.id === heldAdjustmentId);
    // Prefer the approval on the row just read from the server over what the screen sent.
    const evidence = row?.executionApprovalId ?? approvalEvidenceId ?? null;
    if (!evidence)
      throw new ActionFailure(
        "APPROVAL_REQUIRED",
        "Approve this write-off before posting.",
      );
    const receipt = await this.deps.commands.execute(
      "POST /api/v1/inventory/held-adjustments/:id/post",
      { heldAdjustmentId },
      evidence,
    );
    return {
      heldAdjustmentId,
      stockReferenceId: receipt.result.stockReferenceId,
      alreadyApplied: receipt.result.effect === "already_applied",
    };
  }

  private async heldWriteOffRows(): Promise<HeldWriteOffAtCounter[]> {
    try {
      return await this.deps.api.request<HeldWriteOffAtCounter[]>(
        "GET",
        "/inventory/held-adjustments",
        { branchId: this.branchId() },
      );
    } catch {
      return [];
    }
  }

  private mergeHeldWriteOffs(
    items: CounterWorkItem[],
    rows: HeldWriteOffAtCounter[],
  ): CounterWorkItem[] {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const enriched = items.map((item) => {
      if (item.kind !== "held_adjustment") return item;
      const row = byId.get(item.id);
      if (!row) return item;
      return { ...item, heldAdjustmentStatus: row.status };
    });
    const existing = new Set(
      enriched.filter((i) => i.kind === "held_adjustment").map((i) => i.id),
    );
    const readOnly = rows
      .filter(
        (r) =>
          (r.status === "awaiting_approval" || r.status === "rejected") &&
          !existing.has(r.id),
      )
      .map((r) => this.heldRowToCounterItem(r));
    return [...enriched, ...readOnly].sort((a, b) =>
      b.readyAt.localeCompare(a.readyAt),
    );
  }

  private heldRowToCounterItem(row: HeldWriteOffAtCounter): CounterWorkItem {
    const approved =
      row.status === "approved" && row.executionApprovalId !== null;
    return {
      kind: "held_adjustment",
      id: row.id,
      reference: row.batch.batchNo,
      subject: row.product.name,
      lineCount: 1,
      amount: row.value,
      readyAt: row.decidedAt ?? row.requestedAt,
      requested: { name: row.requester.fullName, at: row.requestedAt },
      approved: row.decider
        ? { name: row.decider.fullName, at: row.decidedAt ?? null }
        : null,
      dispatched: null,
      approval: {
        evidenceId: row.executionApprovalId,
        approvedVersion: row.approvalReview.expectedVersion,
        currentVersion: row.approvalReview.expectedVersion,
        state:
          row.status === "rejected"
            ? "revoked"
            : approved
              ? "matches"
              : "not_needed",
        changes: [],
      },
      operation: "POST /api/v1/inventory/held-adjustments/:id/post",
      heldAdjustmentStatus: row.status,
    };
  }

  private async readyRefunds(branchId: string) {
    const rows = await this.deps.api.request<RawRefundRequest[]>(
      "GET",
      "/sales/refund-requests",
      { branchId },
    );
    return rows.filter((r) => r.readyAtCounter);
  }

  async refundsReady(): Promise<RefundAtCounter[]> {
    return (await this.readyRefunds(this.branchId()))
      .map((r) => ({
        refundRequestId: r.id,
        requestNumber: r.requestNumber,
        invoiceNo: r.invoiceNo,
        amount: r.amount,
        refundMethod: r.refundMethod,
        reason: r.reason,
        requestedBy: r.requester?.fullName ?? null,
        approvedBy: r.approver?.fullName ?? null,
        approvalEvidenceId: r.executionApprovalId,
      }));
  }

  async executeRefund(refundRequestId: string): Promise<RefundExecuted> {
    // Re-read so the approval evidence pinned to the command is the server's current one.
    const ready = (await this.refundsReady()).find(
      (r) => r.refundRequestId === refundRequestId,
    );
    if (!ready)
      throw new ActionFailure(
        "REFUND_NOT_READY",
        "That refund is not waiting at this counter any more.",
      );
    const receipt = await this.deps.commands.execute(
      "POST /api/v1/sales/refund-requests/:id/execute",
      { refundRequestId },
      ready.approvalEvidenceId,
    );
    const { result } = receipt;
    return {
      requestNumber: ready.requestNumber,
      amountMinor: result.amountMinor,
      refundedTo: result.refundedTo.map((r) => ({
        method: r.method,
        amountMinor: r.amountMinor,
      })),
      alreadyApplied: result.effect === "already_applied",
      requestedBy: ready.requestedBy,
      approvedBy: ready.approvedBy,
    };
  }

  /** P5 #51: approved stock-case plans and the batches to count (never the system quantity). */
  async stockCasesReady(): Promise<StockCaseAtCounter[]> {
    return this.deps.api.request<StockCaseAtCounter[]>(
      "GET",
      "/offline-stock-cases/resolutions/ready",
      { branchId: this.branchId() },
    );
  }

  /**
   * Resolve an offline stock case here, with the plan approved on the web: count and correct,
   * post, or link, in one signed command. Refused unless the plan still matches its approval.
   */
  async resolveStockCase(
    resolutionId: string,
    counts: ReadonlyArray<{ batchId: string; countedQty: number }>,
  ): Promise<StockCaseResolved> {
    // Re-read so the approval pinned to the command is the server's current one.
    const ready = (await this.stockCasesReady()).find(
      (p) => p.resolutionId === resolutionId,
    );
    if (!ready)
      throw new ActionFailure(
        "STOCK_CASE_NOT_READY",
        "That stock case is not waiting at this counter any more.",
      );
    if (ready.approvalState !== "matches" || !ready.approvalEvidenceId)
      throw new ActionFailure(
        "APPROVAL_STALE",
        "This plan changed since it was approved. Ask for it to be approved again on the web.",
      );
    const receipt = await this.deps.commands.execute(
      "POST /api/v1/offline-stock-cases/resolutions/:id/execute",
      {
        resolutionId,
        counts:
          ready.kind === "count_and_correct"
            ? counts.map((c) => ({ batchId: c.batchId, countedQty: c.countedQty }))
            : [],
      },
      ready.approvalEvidenceId,
    );
    const { result } = receipt;
    return {
      invoiceNo: ready.invoiceNo,
      kind: result.kind,
      alreadyApplied: result.effect === "already_applied",
      batches: result.batches.map((b) => ({
        batchId: b.batchId,
        method: b.method,
        countedQty: b.countedQty,
        correctionQty: b.correctionQty,
        postedQty: b.postedQty,
        stillBlocked: b.stillBlocked,
      })),
      requestedBy: ready.requestedBy,
      approvedBy: ready.approvedBy,
    };
  }

  async cashPayoutsReady(): Promise<CashPayoutAtCounter[]> {
    const rows = await this.deps.api.request<SupplierCashPayoutView[]>(
      "GET",
      "/purchasing/cash-payouts?readyAtCounter=true",
      { branchId: this.branchId() },
    );
    return rows.map((row) => ({
      cashPayoutId: row.id,
      payoutNumber: row.payoutNumber,
      supplierName: row.supplier?.name ?? null,
      purchaseOrderNumber: row.purchaseOrder?.poNumber ?? null,
      amount: row.amount,
      paidOn: row.paidOn,
      reference: row.reference,
      notes: row.notes,
      allocations: row.allocations.map((part) => ({
        invoiceId: part.invoiceId,
        amount: part.amount,
      })),
      executionApprovalId: row.executionApprovalId,
      requestedBy: row.requester?.fullName ?? null,
      approvedBy: row.approver?.fullName ?? null,
    }));
  }

  async executeCashPayout(cashPayoutId: string): Promise<CashPayoutExecuted> {
    const ready = (await this.cashPayoutsReady()).find((r) => r.cashPayoutId === cashPayoutId);
    if (!ready)
      throw new ActionFailure(
        "PAYOUT_NOT_READY",
        "That payout is not waiting at this counter any more.",
      );
    const receipt = await this.deps.commands.execute(
      "POST /api/v1/purchasing/cash-payouts/:id/execute",
      { cashPayoutId },
      ready.executionApprovalId,
    );
    const { result } = receipt;
    const movementReason = ready.purchaseOrderNumber
      ? `Supplier payout · ${ready.purchaseOrderNumber}`
      : `Supplier payout · ${ready.payoutNumber}`;
    return {
      payoutNumber: ready.payoutNumber,
      amountMinor: result.amountMinor,
      supplierPaymentId: result.supplierPaymentId,
      alreadyApplied: result.effect === "already_applied",
      requestedBy: ready.requestedBy,
      approvedBy: ready.approvedBy,
      movementReason,
      supplierName: ready.supplierName,
      expectedCashMinorAfter: null,
    };
  }
}
