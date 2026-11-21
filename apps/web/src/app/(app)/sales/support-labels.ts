import { PAYMENT_METHOD_LABELS } from "./constants";
import type { PaymentMethod } from "./types";
import { DASH } from "./utils";

/**
 * Mirrors `SUPPORT_HELD_REASONS` in `apps/api/src/terminals/journal/support-evidence.ts`
 * (manager-facing copy for support evidence codes).
 */
export const SUPPORT_HELD_REASON_LABELS: Record<string, string> = {
  sign_in_unverified: "Waiting for the counter to upload the staff sign-in this record cites.",
  shift_unverified: "Waiting for the shift this record cites to reach the server.",
  sale_unverified: "Waiting for the counter to upload the sale entry this record cites.",
  payment_unverified: "Waiting for the card approval and the sale it was linked to.",
  outage_unverified: "Waiting for a journal entry from the outage this acknowledgement covers.",
  grant_unverified: "Not verified yet.",
  enrollment_revoked:
    "Uploaded by a revoked or retired counter: review it with the counter's recovery.",
  attempt_mismatch: "The card attempt's events disagree with each other: review the whole attempt.",
  card_payment_mismatch:
    "The linked sale holds no card payment matching this approval and amount.",
  sale_not_honoured:
    "The card was charged for a sale a manager did not honour: settle it with the customer.",
  card_not_used:
    "The card was approved but no sale used it. The counter says it was reversed on the card machine, or that a refund is owed: check the money went back.",
};

export function supportHeldReasonLabel(code: string | null | undefined): string {
  if (!code) return DASH;
  return SUPPORT_HELD_REASON_LABELS[code] ?? code;
}

export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return DASH;
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;
}