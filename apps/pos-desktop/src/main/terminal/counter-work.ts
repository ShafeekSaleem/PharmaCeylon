import type {
  CounterWorkItem,
  RefundAtCounter,
  RefundExecuted,
} from "../../shared/ipc-contract";
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
    try {
      return await this.deps.api.request<CounterWorkItem[]>(
        "GET",
        "/counter-work",
        { branchId },
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 403) return [];
      if (error.status !== 404) throw error;
    }
    return (await this.readyRefunds(branchId)).map(
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
}
