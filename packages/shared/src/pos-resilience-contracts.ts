import type { OfflineBusinessHoursAcknowledgement, TerminalIdentity } from "./terminal-contracts";

/** P0 evidence contracts shared by API and desktop. No payment processing or durable store here. */
export type OfflineSaleIncident = Readonly<{
  contractVersion: 1;
  kind: "sale_incident";
  recordId: string;
  identity: TerminalIdentity;
  saleCommandId: string;
  recordedByUserId: string;
  staffSignInId: string;
  workSessionId: string;
  recordedAt: number;
  category: "quantity_error" | "payment_uncertain" | "customer_dispute" | "other";
  description: string;
  // Append-only note for online review: never changes a sale, stock, cash or payment.
}>;

/** Persist before asking the separate card terminal to charge; never store card credentials.
 * Recovery actions do not override sale authorization/expiry or permit historical backdating. */
export type ExternalCardAttemptRecord = Readonly<{
  contractVersion: 1;
  kind: "external_card_attempt";
  recordId: string; // unique immutable event; multiple events can reference the same attemptId
  identity: TerminalIdentity;
  attemptId: string;
  checkoutDraftId: string;
  reviewedSaleDigest: string; // exact quantities, snapshot prices/tax and split tender being paid
  amountMinor: number;
  staffSignInId: string;
  workSessionId: string;
  recordedAt: number;
}> & (
  | Readonly<{ state: "prepared" | "uncertain" }>
  | Readonly<{ state: "approved"; providerReference: string; approvalCode: string; approvedAt: number }>
  | Readonly<{ state: "declined"; providerReference: string; verifiedByUserId: string }>
  | Readonly<{ state: "linked_to_sale"; providerReference: string; saleCommandId: string }>
);
export function externalCardRecoveryAction(state: ExternalCardAttemptRecord["state"]):
  "verify_original_attempt" | "complete_original_sale" | "retry_payment_with_new_attempt" | "recover_receipt" {
  switch (state) {
    case "prepared": case "uncertain": return "verify_original_attempt";
    case "approved": return "complete_original_sale";
    case "declined": return "retry_payment_with_new_attempt";
    case "linked_to_sale": return "recover_receipt";
    default: throw new Error("Invalid payment attempt state");
  }
}

/** True when free text holds what may be a full card number: 13–19 digits, optionally separated by
 * single spaces or dashes, that pass the Luhn check. Check before signing a support record; the API
 * refuses such records so no PAN is ever stored.
 *
 * Within a run of digits groups ("qty 3 4111 1111 1111 1111 2"), every contiguous span of whole
 * groups is tested, so neighbouring digits cannot hide a card number. Inside one unbroken group
 * longer than a 16-digit card ("4111111111111111000"), every 13–19 digit window is tested. That
 * flags more long references; a refused record is rewritten, a stored PAN can never be removed. */
export function containsCardNumber(value: string): boolean {
  for (const match of value.matchAll(/\d(?:[ -]?\d)*/g)) {
    const groups = match[0].split(/[ -]/);
    for (let start = 0; start < groups.length; start++) {
      let digits = "";
      for (let end = start; end < groups.length && digits.length < 19; end++) {
        digits += groups[end];
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
      }
    }
    for (const group of groups) {
      if (group.length <= 16) continue;
      for (let length = 13; length <= 19; length++)
        for (let at = 0; at + length <= group.length; at++)
          if (luhn(group.slice(at, at + length))) return true;
    }
  }
  return false;
}
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** An independent evidence stream: IDs/digests deduplicate; no sale/shift sequence is consumed.
 * Upload dependencies before dependent commands; retain held evidence and gate drain completion.
 */
export type OfflineSupportRecord = OfflineBusinessHoursAcknowledgement | OfflineSaleIncident | ExternalCardAttemptRecord;

/** Current readiness facts come from trusted main/server state, not renderer claims.
 * This summarizes outage-entry preparation; it is not authorization for an individual sale.
 */
export type OfflineReadinessFacts = Readonly<{
  nominated: boolean;
  grantUsable: boolean;
  snapshotFreshForOutageEntry: boolean;
  preparedStaffAvailable: boolean;
  localStorageHealthy: boolean;
  trustedClock: boolean;
  localAttendanceVerified: boolean;
  unresolvedPaymentAttempt: boolean;
  syncInProgress: boolean;
}>;
export function offlineReadinessIssues(facts: OfflineReadinessFacts): ReadonlyArray<string> {
  const issues: string[] = [];
  for (const key of ["nominated", "grantUsable", "snapshotFreshForOutageEntry", "preparedStaffAvailable",
    "localStorageHealthy", "trustedClock", "localAttendanceVerified"] as const) {
    if (!facts[key]) issues.push(key);
  }
  if (facts.unresolvedPaymentAttempt) issues.push("unresolvedPaymentAttempt");
  if (facts.syncInProgress) issues.push("syncInProgress");
  return issues;
}

/** Debouncing is performed by P4/P5; a single successful probe is not this evidence. */
export type ReconnectDrainReadiness = Readonly<{
  authenticatedConnectionStable: boolean;
  currentCheckoutDurablyQuiesced: boolean;
  unresolvedPaymentsDurablyRecorded: boolean;
}>;
export function mayBeginReconnectDrain(evidence: ReconnectDrainReadiness): boolean {
  return evidence.authenticatedConnectionStable && evidence.currentCheckoutDurablyQuiesced && evidence.unresolvedPaymentsDurablyRecorded;
}

/** Persisted settlement evidence, not an automatic stock correction or permission to unblock. */
export type StockDiscrepancySettlementEvidence = Readonly<{
  caseId: string;
  tenantId: string;
  branchId: string;
  batchId: string;
  saleCommandIds: ReadonlyArray<string>;
  stockTimelineDigest: string;
  physicalCountId: string;
  physicalCountAt: number;
  countedByUserId: string;
  countAlreadyIncludesSaleCommandIds: ReadonlyArray<string>;
  resolution: "post_missing_movement" | "link_existing_settlement";
  linkedStockMovementIds: ReadonlyArray<string>;
  approvalEvidenceId: string;
  executionCommandId: string;
  reason: string;
}>;
