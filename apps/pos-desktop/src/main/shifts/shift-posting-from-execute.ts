import type {
  OnlineCommandReceipt,
  SignedPhysicalOperation,
} from "@pharmaceylon/shared";
import type { ReturnOutcome } from "../../shared/ipc-contract";
import type { ShiftService } from "./shift-service";

export const PAYOUT_EXECUTE =
  "POST /api/v1/purchasing/cash-payouts/:id/execute" as const satisfies SignedPhysicalOperation;
export const REFUND_EXECUTE =
  "POST /api/v1/sales/refund-requests/:id/execute" as const satisfies SignedPhysicalOperation;

type RefundedTo = ReadonlyArray<
  Readonly<{ method: string; amountMinor: number }>
>;

/** Direct counter execute: never book drawer cash when another counter already paid. */
export function recordAfterDirectPayoutExecute(
  shifts: ShiftService,
  cashPayoutId: string,
  amountMinor: number,
  executorId: string,
  alreadyApplied: boolean,
): void {
  if (alreadyApplied) return;
  shifts.recordSupplierPayout(cashPayoutId, amountMinor, executorId);
}

export function recordAfterDirectRefundExecute(
  shifts: ShiftService,
  refundRequestId: string,
  refundedTo: RefundedTo,
  executorId: string,
  alreadyApplied: boolean,
): void {
  if (alreadyApplied) return;
  shifts.recordRefund(refundRequestId, refundedTo, executorId);
}

/**
 * A Returns outcome — from submitting a return, or from a manager's co-sign that let it execute.
 * Only a refund that executed here moves the drawer; one still waiting for approval moves nothing.
 */
export function recordAfterReturnOutcome(
  shifts: ShiftService,
  outcome: ReturnOutcome,
  executorId: string,
): void {
  if (outcome.status !== "refunded") return;
  recordAfterDirectRefundExecute(
    shifts,
    outcome.refund.refundRequestId,
    outcome.refund.refundedTo,
    executorId,
    outcome.refund.alreadyApplied,
  );
}

/**
 * Lost-response retry on this counter: book drawer cash once from the command receipt this
 * device signed. Everything it needs is in the receipt, so it works with no further network
 * call. A receipt whose effect is "already_applied" means another command paid — this drawer
 * did not, so nothing is booked. Safe to call on every replay: posting ids are unique per
 * payout / refund request.
 */
export function recordAfterCommandRetry(
  shifts: ShiftService,
  receipt: OnlineCommandReceipt,
  executorId: string,
): void {
  if (receipt.operation === PAYOUT_EXECUTE) {
    const { result } = receipt as OnlineCommandReceipt<typeof PAYOUT_EXECUTE>;
    if (result.effect === "already_applied") return;
    shifts.recordSupplierPayout(
      result.cashPayoutId,
      result.amountMinor,
      executorId,
    );
    return;
  }
  if (receipt.operation === REFUND_EXECUTE) {
    const { result } = receipt as OnlineCommandReceipt<typeof REFUND_EXECUTE>;
    if (result.effect === "already_applied") return;
    shifts.recordRefund(result.refundRequestId, result.refundedTo, executorId);
  }
}
