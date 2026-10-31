import type { RefundAtCounter, RefundExecuted } from "../../shared/ipc-contract";
import type { ApiSession } from "../api/api-client";
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
};

/**
 * Work prepared and approved remotely that only the counter may execute (revised D10). The list
 * shows who asked and who approved; executing records the signed-in person as the executor.
 */
export class CounterWorkService {
  constructor(private readonly deps: { api: ApiSession; terminal: TerminalService; commands: SignedCommandService }) {}

  private branchId() {
    const current = this.deps.terminal.current();
    if (!current) throw new ActionFailure("NOT_SIGNED_IN", "Sign in at this counter first.");
    return current.identity.branchId;
  }

  async refundsReady(): Promise<RefundAtCounter[]> {
    const rows = await this.deps.api.request<RawRefundRequest[]>("GET", "/sales/refund-requests", {
      branchId: this.branchId(),
    });
    return rows
      .filter((r) => r.readyAtCounter)
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
    const ready = (await this.refundsReady()).find((r) => r.refundRequestId === refundRequestId);
    if (!ready) throw new ActionFailure("REFUND_NOT_READY", "That refund is not waiting at this counter any more.");
    const receipt = await this.deps.commands.execute(
      "POST /api/v1/sales/refund-requests/:id/execute",
      { refundRequestId },
      ready.approvalEvidenceId,
    );
    const { result } = receipt;
    return {
      requestNumber: ready.requestNumber,
      amountMinor: result.amountMinor,
      refundedTo: result.refundedTo.map((r) => ({ method: r.method, amountMinor: r.amountMinor })),
      alreadyApplied: result.effect === "already_applied",
      requestedBy: ready.requestedBy,
      approvedBy: ready.approvedBy,
    };
  }
}
