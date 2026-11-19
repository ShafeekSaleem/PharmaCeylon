import type { OnlineCommandReceipt, SignedPhysicalOperation } from "@pharmaceylon/shared";
import type { ShiftService } from "./shift-service";

export const PAYOUT_EXECUTE =
  "POST /api/v1/purchasing/cash-payouts/:id/execute" as const satisfies SignedPhysicalOperation;
export const REFUND_EXECUTE =
  "POST /api/v1/sales/refund-requests/:id/execute" as const satisfies SignedPhysicalOperation;

type PayoutExecuteResult = {
  cashPayoutId: string;
  amountMinor: number;
};

type RefundExecuteResult = {
  amountMinor: number;
  refundedTo: ReadonlyArray<Readonly<{ method: string; amountMinor: number }>>;
};

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
  requestNumber: string,
  refundedTo: ReadonlyArray<Readonly<{ method: string; amountMinor: number }>>,
  executorId: string,
  alreadyApplied: boolean,
): void {
  if (alreadyApplied) return;
  shifts.recordRefund(
    requestNumber,
    refundedTo.map((r) => ({ method: r.method, amountMinor: r.amountMinor })),
    executorId,
  );
}

/**
 * Lost-response retry on this counter: book drawer cash once from the command receipt this device
 * signed. Safe to call on every replay — posting ids are unique per payout / refund request.
 */
export function recordAfterCommandRetry(
  shifts: ShiftService,
  receipt: OnlineCommandReceipt,
  executorId: string,
  refundRequestNumber?: string | null,
): void {
  if (receipt.operation === PAYOUT_EXECUTE) {
    const result = receipt.result as PayoutExecuteResult & { type: string };
    const postingId = `payout:${result.cashPayoutId}`;
    if (shifts.hasPosting(postingId)) return;
    shifts.recordSupplierPayout(result.cashPayoutId, result.amountMinor, executorId);
    return;
  }
  if (receipt.operation === REFUND_EXECUTE && refundRequestNumber) {
    const result = receipt.result as RefundExecuteResult & { type: string };
    const postingId = `refund:${refundRequestNumber}`;
    if (shifts.hasPosting(postingId)) return;
    const refundedTo =
      result.refundedTo.length > 0
        ? result.refundedTo.map((r) => ({ method: r.method, amountMinor: r.amountMinor }))
        : [{ method: "cash", amountMinor: result.amountMinor }];
    shifts.recordRefund(refundRequestNumber, refundedTo, executorId);
  }
}