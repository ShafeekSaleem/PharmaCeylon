import { BadRequestException } from "@nestjs/common";
import type {
  BranchStockSnapshot,
  OfflineSaleCommand,
} from "@pharmaceylon/shared";

/**
 * P5 #51 slice 4: the rules for settling an offline journal entry the server rejected. Pure: the
 * service reads the stored evidence and the till, then asks these.
 */

export const SETTLEMENT_DECISIONS = ["recorded", "not_honoured"] as const;
export type SettlementDecision = (typeof SETTLEMENT_DECISIONS)[number];

export function parseDecision(raw: unknown): SettlementDecision {
  if (
    typeof raw !== "string" ||
    !(SETTLEMENT_DECISIONS as readonly string[]).includes(raw)
  )
    throw new BadRequestException("decision is recorded or not_honoured");
  return raw as SettlementDecision;
}

/** A reason is required for both decisions: either one is an exception to the offline rules. */
export function parseReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason) throw new BadRequestException("Say why");
  if (reason.length > 500)
    throw new BadRequestException("Keep the reason under 500 characters");
  return reason;
}

/**
 * Why an entry can't be recorded as it happened. It can still be not honoured. Recording writes
 * the counter's own figures, so they must be exactly what its signed snapshot allowed, add up,
 * and land on a shift and batches the server has.
 */
export type RecordBlocker =
  | "grant_unknown"
  | "snapshot_unknown"
  | "sign_in_missing"
  | "lines_unknown"
  | "prices_differ"
  | "totals_differ"
  | "payments_differ"
  | "batch_missing"
  | "shift_not_open"
  | "till_mismatch"
  | "till_has_open_shift"
  | "shift_id_used";

export const RECORD_BLOCKER_MESSAGES: Readonly<Record<RecordBlocker, string>> =
  {
    grant_unknown:
      "It names an offline permission this server never issued to this counter.",
    snapshot_unknown:
      "It names saved stock this server never issued to this counter.",
    sign_in_missing: "The staff sign-in it names never reached the server.",
    lines_unknown: "Some of its items are not in the saved stock it names.",
    prices_differ: "Its prices or tax are not the saved stock's.",
    totals_differ: "Its lines don't add up to its total.",
    payments_differ: "Its payments don't add up to its total.",
    batch_missing: "A batch it sold from is no longer at this branch.",
    shift_not_open: "The shift it belongs to is not open on the server.",
    till_mismatch:
      "It names another register or till than the counter's offline permission.",
    till_has_open_shift: "Another shift is already open on this till.",
    shift_id_used: "Its shift number is already used.",
  };

/** Why no decision can be made on this refusal here at all. */
export type SettleBlocker =
  | "not_rejected"
  | "not_next"
  | "settled"
  | "counter_revoked";

export const SETTLE_BLOCKER_MESSAGES: Readonly<Record<SettleBlocker, string>> =
  {
    not_rejected: "Only records the server rejected are settled here.",
    not_next:
      "This record no longer follows what the server accepted from the counter (another record took its place). Nothing to settle.",
    settled: "This record is already settled.",
    counter_revoked:
      "This counter was revoked or retired. Its journal is recovered through journal recovery, not settled here.",
  };

const isSafe = (n: unknown, min = 0): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min;

/**
 * The money of a refused sale, checked against the signed snapshot it names, exactly as the offline
 * policy would (D6 prices, half-up tax per line, totals, tender). The rule the counter broke (hours,
 * permission expiry, local stock, a payment method) is what the manager is deciding about; figures
 * that don't add up can't be recorded, whatever the decision.
 */
export function recordedSaleError(
  command: OfflineSaleCommand,
  snapshot: BranchStockSnapshot,
): RecordBlocker | null {
  if (
    command.currency !== "LKR" ||
    !command.lines.length ||
    !command.payments.length
  )
    return "totals_differ";
  if (!isSafe(command.totalMinor)) return "totals_differ";
  const seen = new Set<string>();
  let total = 0;
  for (const line of command.lines) {
    const known = snapshot.lines.find(
      (l) => l.snapshotLineId === line.snapshotLineId,
    );
    if (!known || seen.has(line.snapshotLineId)) return "lines_unknown";
    seen.add(line.snapshotLineId);
    if (
      !isSafe(line.quantity, 1) ||
      !isSafe(line.unitPriceMinor) ||
      !isSafe(line.taxMinor)
    )
      return "totals_differ";
    if (
      line.unitPriceMinor !== known.unitPriceMinor ||
      line.discountMinor !== 0
    )
      return "prices_differ";
    const net = line.quantity * line.unitPriceMinor;
    if (!Number.isSafeInteger(net)) return "totals_differ";
    const tax = Number(
      (BigInt(net) * BigInt(known.taxBasisPoints) + 5000n) / 10000n,
    );
    if (line.taxMinor !== tax) return "prices_differ";
    total += net + tax;
    if (!Number.isSafeInteger(total)) return "totals_differ";
  }
  if (total !== command.totalMinor) return "totals_differ";
  let paid = 0;
  for (const payment of command.payments) {
    if (!isSafe(payment.amountMinor)) return "payments_differ";
    if (payment.method === "cash") {
      if (!isSafe(payment.tenderedMinor) || !isSafe(payment.changeMinor))
        return "payments_differ";
      if (payment.tenderedMinor - payment.changeMinor !== payment.amountMinor)
        return "payments_differ";
    } else if (payment.method === "external_card") {
      // Recorded even where the permission did not allow card (the money was taken), but only
      // with the card machine's reference to reconcile it against.
      if (!payment.providerReference.trim()) return "payments_differ";
    } else return "payments_differ";
    paid += payment.amountMinor;
    if (!Number.isSafeInteger(paid)) return "payments_differ";
  }
  return paid === command.totalMinor ? null : "payments_differ";
}

/**
 * When a recorded entry is dated: when the counter says it happened, but never after the server
 * first received it (a clock ahead of the server is why some entries are refused).
 */
export function recordedOccurredAt(
  occurredAt: number,
  firstReceivedAt: Date,
): Date {
  return new Date(Math.min(occurredAt, firstReceivedAt.getTime()));
}

/** What the server's refusal means, in words for the manager deciding. */
export function refusalExplanation(code: string): string {
  switch (code) {
    case "GRANT_EXPIRED":
      return "Sold after the counter's 24-hour offline permission had run out.";
    case "OUTSIDE_OPERATING_HOURS":
      return "Made outside the branch's selling hours.";
    case "BUSINESS_HOURS_ACK_REQUIRED":
      return "Made after hours without a valid manager's after-hours acknowledgement.";
    case "LOCAL_STOCK_EXHAUSTED":
      return "Sold more than the counter's saved stock allowed.";
    case "RECONCILIATION_REQUIRED":
      return "Sold from a batch that was under stock review.";
    case "ONLINE_REQUIRED":
      return "Sold from a batch past its offline sell-by date (near or past expiry).";
    case "PAYMENT_NOT_ALLOWED":
      return "Took a payment method the counter's offline permission didn't allow.";
    case "SESSION_INVALID":
      return "The staff sign-in or shift doesn't match the counter's offline permission or the till's shifts.";
    case "CLOCK_UNTRUSTED":
      return "Its time can't be trusted: ahead of the server, or before the counter's previous record.";
    case "SNAPSHOT_STALE":
      return "The counter's saved stock was too old when the outage began.";
    case "SNAPSHOT_MISMATCH":
      return "It doesn't match the saved stock or outage it names.";
    case "SNAPSHOT_INVALID":
      return "It names saved stock this server never issued.";
    case "GRANT_INVALID":
      return "It names an offline permission this server never issued to this counter.";
    case "IDENTITY_MISMATCH":
      return "It names another counter.";
    case "INVALID_COMMAND":
    case "UNSUPPORTED_CONTRACT":
      return "Its fields or amounts don't add up.";
    default:
      return `Refused by the offline rules (${code}).`;
  }
}
