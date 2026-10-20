/** P0 wire contract v1. See docs/POS_V1_CONTRACT.md for trust and persistence rules. */
export const TERMINAL_CONTRACT_VERSION = 1 as const;
/** Approved D3: expires at most 24 hours after the last successful online permission renewal. */
export const MAX_OFFLINE_GRANT_MS = 24 * 60 * 60 * 1000;
/** Approved D4: saved stock may be at most 15 minutes old at the original outage start. */
export const MAX_SNAPSHOT_AGE_AT_OUTAGE_MS = 15 * 60 * 1000;

/** Deterministic, integer-only wire encoding; callers UTF-8 encode before signing/hash. */
export function terminalSigningText(purpose: "grant" | "snapshot" | "command" | "sync_response", payload: unknown): string {
  const visiting = new Set<object>();
  function encode(value: unknown): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("Non-canonical number");
      return String(value);
    }
    if (typeof value !== "object" || value === null || visiting.has(value)) throw new Error("Non-canonical value");
    visiting.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getOwnPropertyNames(value).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) throw new Error("Non-canonical array");
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const property = Object.getOwnPropertyDescriptor(value, i);
          if (!property || !property.enumerable || !("value" in property)) throw new Error("Non-canonical array item");
          items.push(encode(property.value));
        }
        return `[${items.join(",")}]`;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Non-plain object");
      if (Object.getOwnPropertySymbols(value).length) throw new Error("Symbol key");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return `{${Object.keys(descriptors).sort().map(key => {
        const property = descriptors[key];
        if (!property.enumerable || !("value" in property)) throw new Error("Non-canonical property");
        return `${JSON.stringify(key)}:${encode(property.value)}`;
      }).join(",")}}`;
    } finally { visiting.delete(value); }
  }
  if (!["grant", "snapshot", "command", "sync_response"].includes(purpose)) throw new Error("Invalid signature purpose");
  return `PharmaCeylon:terminal:v1:${purpose}\n${encode(payload)}`;
}

/** UTC epoch milliseconds; quantities are base units; money is LKR minor units. */
export type TerminalIdentity = Readonly<{
  tenantId: string;
  branchId: string;
  terminalId: string;
  enrollmentId: string;
  keyId: string;
}>;

export type WorkSessionIdentity = Readonly<{
  registerId: string;
  tillId: string;
  workSessionId: string;
  staffUserId: string;
}>;

/** Approved D7a/b: prepare staff online; create work-session IDs locally for new offline shifts. */
export type OfflineStaffAuthorization = Readonly<{
  staffUserId: string;
  staffAuthorizationId: string;
  credentialVersion: number;
  signInMethod: "personal_pin";
}>;

/** Main-process attestation after checking the prepared local credential, never a PIN payload. */
export type OfflineStaffSignIn = Readonly<{
  contractVersion: 1;
  kind: "offline_staff_sign_in";
  staffSignInId: string;
  identity: TerminalIdentity;
  session: WorkSessionIdentity;
  grantId: string;
  grantVersion: number;
  staffAuthorizationId: string;
  credentialVersion: number;
  method: "personal_pin";
  authenticatedAt: number;
}>;

/** Server-persisted proof of live approval; never contains the approver's PIN/password. */
export type PharmacistEvidence = Readonly<{
  evidenceId: string;
  tenantId: string;
  branchId: string;
  workSessionId: string;
  approverUserId: string;
  commandId: string;
  operationDigest: string; // digest of operation/body/identity/session before evidence ID is attached
  reason: string;
  verifiedAt: number;
  expiresAt: number;
  policyVersion: number;
}>;

export type Signed<T> = Readonly<{
  algorithm: "Ed25519";
  keyId: string;
  payload: T;
  signature: string; // base64url, no padding; signature over canonical payload bytes
}>;

/** Last-known sellable balance, NOT a reservation or a promise of current availability.
 * Approved D2: server includes only non-prescription, non-controlled products here.
 */
export type StockSnapshotLine = Readonly<{
  snapshotLineId: string;
  productId: string;
  batchId: string;
  availableQuantity: number;
  stockReviewRequired: boolean; // approved D1: unresolved stock posting blocks sales from this batch
  unitPriceMinor: number;
  taxBasisPoints: number;
  sellBefore: number; // exclusive UTC instant, resolved from branch business date
}>;

/** Server signs a consistent stock/catalog view and the device journal inclusion watermark. */
export type BranchStockSnapshot = Readonly<{
  contractVersion: 1;
  kind: "branch_stock_snapshot";
  snapshotId: string;
  snapshotVersion: number;
  identity: TerminalIdentity;
  generatedAt: number;
  includedThroughSequence: number;
  includedThroughHash: string | null;
  lines: ReadonlyArray<StockSnapshotLine>;
}>;

export type OfflineGrant = Readonly<{
  contractVersion: 1;
  kind: "offline_grant";
  identity: TerminalIdentity;
  registerId: string;
  tillId: string;
  authorizedStaff: ReadonlyArray<OfflineStaffAuthorization>;
  grantId: string;
  grantVersion: number;
  nominationVersion: number;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  maxSnapshotAgeAtOutageMs: number; // must equal MAX_SNAPSHOT_AGE_AT_OUTAGE_MS in v1 (approved D4)
  currency: "LKR";
  // Approved D9: no offline sale-count, per-sale-value or cumulative-value caps.
  externalCardAllowed: boolean;
  policyVersion: number;
  operatingWindows: ReadonlyArray<Readonly<{ startsAt: number; endsAt: number }>>;
  operatingHoursException: null | Readonly<{
    approvalId: string;
    approverUserId: string;
    reason: string;
    startsAt: number;
    endsAt: number;
  }>;
}>;

export type OrdinarySaleLine = Readonly<{
  snapshotLineId: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxMinor: number;
}>;

/** Approved D5: cash and externally approved card, including split tender; no wallet/credit. */
export type OfflinePayment =
  | Readonly<{ method: "cash"; amountMinor: number; tenderedMinor: number; changeMinor: number }>
  | Readonly<{
      method: "external_card";
      amountMinor: number;
      providerReference: string;
      approvalCode: string;
      approvedAt: number;
    }>;

/** Approved D10: created only by the enrolled local desktop after verified attendance/staff checks. */
export type OfflineCommandContext = Readonly<{
  contractVersion: 1;
  commandId: string;
  identity: TerminalIdentity;
  session: WorkSessionIdentity;
  staffSignInId: string; // references authenticated local sign-in evidence, never a claimed user ID alone
  sequence: number; // starts at 1 per enrollment; never reset per grant/session
  previousCommandHash: string | null; // null only at sequence 1
  occurredAt: number;
  grantId: string;
  grantVersion: number;
  nominationVersion: number;
  offlineSessionId: string;
  offlineStartedAt: number;
}>;

export type OfflineSaleCommand = OfflineCommandContext & Readonly<{
  kind: "ordinary_sale"; // approved D2: completed-sale voids/refunds/stock operations require online checks
  snapshotId: string;
  snapshotVersion: number;
  currency: "LKR";
  lines: ReadonlyArray<OrdinarySaleLine>;
  payments: ReadonlyArray<OfflinePayment>;
  totalMinor: number;
}>;

/** Approved D7b: shifts share the same terminal journal sequence, stock usage and expiry. */
export type OfflineShiftOpenCommand = OfflineCommandContext & Readonly<{
  kind: "shift_open";
  currency: "LKR";
  openingCashMinor: number;
  previousClosedWorkSessionId: string | null;
}>;
export type OfflineShiftCloseCommand = OfflineCommandContext & Readonly<{
  kind: "shift_close";
  currency: "LKR";
  closingCashCountMinor: number;
  expectedCashMinor: number; // derived locally from opening cash and immutable cash postings, not a renderer claim
}>;
export type OfflineJournalCommand = OfflineSaleCommand | OfflineShiftOpenCommand | OfflineShiftCloseCommand;
export type LocalOpenTillShift = Readonly<{
  identity: TerminalIdentity;
  session: WorkSessionIdentity;
  openedAt: number;
  openingCashMinor: number;
}>;

/** Approved D10: local enrolled desktop only, including for owners; no browser/mobile/remote writes.
 * P1/P2 must verify device/local-session evidence, live domain DTOs, permissions and approvals.
 * A signed shape or a client-supplied header alone does not establish local attendance.
 */
export type OnlineTerminalCommand<T> = Readonly<{
  contractVersion: 1;
  kind: "online_operation";
  commandId: string;
  identity: TerminalIdentity;
  session: WorkSessionIdentity;
  operation: string; // exact method + route from POS_OPERATIONAL_MUTATIONS.md
  issuedAt: number;
  expiresAt: number;
  serverNonce: string; // single-use, server-issued, bound to command digest
  body: T;
  pharmacistEvidenceId: string | null;
  operatingHoursExceptionId: string | null;
}>;

export const TERMINAL_ERROR_CODES = [
  "INVALID_COMMAND", "UNSUPPORTED_CONTRACT", "INVALID_SIGNATURE", "IDENTITY_MISMATCH",
  "TERMINAL_REQUIRED", "REMOTE_SESSION_DENIED", "TERMINAL_REVOKED", "SESSION_INVALID",
  "ONLINE_REQUIRED", "GRANT_INVALID", "GRANT_EXPIRED", "SNAPSHOT_INVALID", "SNAPSHOT_MISMATCH",
  "SNAPSHOT_STALE", "LOCAL_STOCK_EXHAUSTED", "OUTSIDE_OPERATING_HOURS", "CLOCK_UNTRUSTED",
  "PAYMENT_NOT_ALLOWED", "PHARMACIST_REQUIRED", "REPLAY_CONFLICT", "SEQUENCE_GAP",
  "RECONCILIATION_REQUIRED", "TEMPORARILY_UNAVAILABLE",
] as const;
export type TerminalErrorCode = typeof TERMINAL_ERROR_CODES[number];
export type TerminalApiError = Readonly<{
  contractVersion: 1;
  code: TerminalErrorCode;
  message: string;
  correlationId: string;
  retryable: boolean;
}>;

/** Conflict handling approved in decision D1; see docs/POS_V1_REVIEW.md. */
export type StockPostingOutcome =
  | Readonly<{ stockPosting: "posted"; reconciliationCaseId: null }>
  | Readonly<{ stockPosting: "pending_reconciliation"; reconciliationCaseId: string }>;
export type OfflineStockDiscrepancy = Readonly<{
  caseId: string;
  identity: TerminalIdentity;
  commandId: string;
  saleId: string;
  snapshotId: string;
  snapshotVersion: number;
  batchId: string;
  soldQuantity: number;
  availableQuantityAtSync: number;
  shortfallQuantity: number;
  status: "open" | "resolved";
}>;

export type SyncAcknowledgement = Readonly<{
  commandId: string;
  commandHash: string;
  sequence: number;
}> & (
  | (Readonly<{ commandKind: "ordinary_sale"; status: "committed" | "duplicate"; saleId: string; committedAt: number }> & StockPostingOutcome)
  | Readonly<{ commandKind: "shift_open" | "shift_close"; status: "committed" | "duplicate";
      workSessionId: string; committedAt: number }>
  | Readonly<{ status: "held" | "rejected"; error: TerminalApiError }>
);
export type SyncRequest = Readonly<{
  contractVersion: 1;
  identity: TerminalIdentity;
  staffSignIns: ReadonlyArray<Signed<OfflineStaffSignIn>>;
  commands: ReadonlyArray<Signed<OfflineJournalCommand>>;
}>;
export type SyncResponse = Readonly<{
  contractVersion: 1;
  identity: TerminalIdentity;
  serverTime: number;
  acknowledgements: ReadonlyArray<SyncAcknowledgement>;
  committedThroughSequence: number;
  committedThroughHash: string | null;
}>;

export type OfflineTerminalState = "nominated" | "ready" | "offline" | "draining" | "revoked";
/** Approved D12: trusted local sync state, not caller-supplied claims. */
export type OnlineCheckoutResumeEvidence = Readonly<{
  authenticated: boolean;
  journalAcceptedThroughLastLocalCommand: boolean;
  uncertainCommandsResolved: boolean;
  freshSnapshotInstalled: boolean;
  stockReviewBlocksInstalled: boolean;
}>;
export function mayResumeOnlineCheckout(evidence: OnlineCheckoutResumeEvidence): boolean {
  return evidence.authenticated && evidence.journalAcceptedThroughLastLocalCommand &&
    evidence.uncertainCommandsResolved && evidence.freshSnapshotInstalled && evidence.stockReviewBlocksInstalled;
}

/** Immutable restart boundary verified against protected durable state by P4. */
export type OfflineRecoveryBoundary = Readonly<{
  grantId: string;
  grantVersion: number;
  grantExpiresAt: number;
  offlineSessionId: string;
  offlineStartedAt: number;
  snapshotId: string;
  snapshotVersion: number;
  lastJournalSequence: number;
  lastJournalHash: string | null;
}>;
export type OfflineRestartEvidence = Readonly<{
  stateBeforeRestart: OfflineTerminalState;
  original: OfflineRecoveryBoundary;
  restored: OfflineRecoveryBoundary;
  journalIntact: boolean;
  stockUsageRestored: boolean;
  staffStateRestored: boolean;
  shiftStateRestored: boolean;
  trustedClockRestored: boolean;
  timeRollbackDetected: boolean;
  trustedNow: number;
}>;
export type OfflineRestartDecision = Readonly<{
  action: "restore_same_offline_session" | "require_online_recovery" | "keep_sync_paused" | "offline_not_permitted";
  reason: TerminalErrorCode | null;
}>;

/** Approved D14: restore only trusted unchanged state; never clear data or renew permission here.
 * This is a policy fixture, not a journal verifier or an OS restart/clock implementation.
 */
export function offlineRestartDecision(evidence: OfflineRestartEvidence): OfflineRestartDecision {
  if (evidence.stateBeforeRestart === "revoked") return { action: "offline_not_permitted", reason: "TERMINAL_REVOKED" };
  if (!evidence.trustedClockRestored || evidence.timeRollbackDetected ||
      !Number.isSafeInteger(evidence.trustedNow) || evidence.trustedNow < 0) {
    return { action: "require_online_recovery", reason: "CLOCK_UNTRUSTED" };
  }
  const boundaryKeys: ReadonlyArray<keyof OfflineRecoveryBoundary> = ["grantId", "grantVersion", "grantExpiresAt",
    "offlineSessionId", "offlineStartedAt", "snapshotId", "snapshotVersion", "lastJournalSequence", "lastJournalHash"];
  const original = evidence.original;
  if (!evidence.journalIntact || !evidence.stockUsageRestored || !evidence.staffStateRestored ||
      !evidence.shiftStateRestored || boundaryKeys.some(k => original[k] !== evidence.restored[k])) {
    return { action: "require_online_recovery", reason: "RECONCILIATION_REQUIRED" };
  }
  try {
    assertSafeInteger(original.grantVersion, 1);
    assertSafeInteger(original.grantExpiresAt);
    assertSafeInteger(original.offlineStartedAt);
    assertSafeInteger(original.snapshotVersion, 1);
    assertSafeInteger(original.lastJournalSequence);
    if (!original.grantId || !original.offlineSessionId || !original.snapshotId ||
        original.grantExpiresAt <= original.offlineStartedAt || original.offlineStartedAt > evidence.trustedNow ||
        (original.lastJournalSequence === 0 ? original.lastJournalHash !== null :
          !/^[a-f0-9]{64}$/.test(original.lastJournalHash ?? ""))) throw new Error("Invalid restart boundary");
  } catch { return { action: "require_online_recovery", reason: "RECONCILIATION_REQUIRED" }; }
  if (evidence.stateBeforeRestart === "draining") return { action: "keep_sync_paused", reason: "ONLINE_REQUIRED" };
  if (evidence.trustedNow >= original.grantExpiresAt) return { action: "offline_not_permitted", reason: "GRANT_EXPIRED" };
  if (evidence.stateBeforeRestart !== "offline") return { action: "offline_not_permitted", reason: "ONLINE_REQUIRED" };
  return { action: "restore_same_offline_session", reason: null };
}
export type OfflineTerminalEvent =
  | "refresh_online" | "connection_lost" | "connection_restored" | "grant_expired"
  | "drain_requested" | "reconciled_online" | "revoke" | "lost";

/** Models lifecycle only. Callers must validate event evidence and persist atomically.
 * Approved D12: reconciled_online requires mayResumeOnlineCheckout evidence; failures stay draining.
 */
export function nextOfflineTerminalState(
  state: OfflineTerminalState,
  event: OfflineTerminalEvent,
): OfflineTerminalState {
  if (event === "revoke" || event === "lost") return "revoked";
  if (state === "revoked") throw new Error("Revoked enrollments cannot be reactivated");
  if ((state === "nominated" || state === "ready") && event === "refresh_online") return "ready";
  if (state === "ready" && event === "connection_lost") return "offline";
  if (state === "offline" && event === "connection_restored") return "draining";
  if (state === "ready" && event === "grant_expired") return "nominated";
  if ((state === "ready" || state === "offline") &&
      (event === "grant_expired" || event === "drain_requested")) return "draining";
  if (state === "draining" && event === "reconciled_online") return "nominated";
  throw new Error(`Invalid terminal transition: ${state}/${event}`);
}

/** Approved D11: offline replacement needs old-grant cutoff and journal/loss review.
 * Server revocation alone cannot stop a disconnected device. Replacement online use need not wait.
 */
export type OfflineReplacementEvidence = Readonly<{
  oldGrantCanNoLongerSell: boolean;
  oldJournalResolvedOrLossReviewed: boolean;
}>;
export function mayEnableOfflineReplacement(evidence: OfflineReplacementEvidence): boolean {
  return evidence.oldGrantCanNoLongerSell && evidence.oldJournalResolvedOrLossReviewed;
}

/** Approved D13: explicit per-user, per-branch delegation; never an automatic manager-role grant. */
export type OfflineTerminalDelegation = Readonly<{
  delegationId: string;
  tenantId: string;
  branchId: string;
  managerUserId: string;
  delegatedByOwnerUserId: string;
  createdAt: number;
  revokedAt: number | null;
}>;
/** Server-resolved authorization facts for the target branch; not fields accepted from a client. */
export type OfflineTerminalManagementContext = Readonly<{
  online: boolean;
  localAttendanceVerified: boolean;
  isOwner: boolean;
  isManagerAtBranch: boolean;
  hasActiveOwnerDelegation: boolean;
}>;
export function mayManageOfflineTerminal(context: OfflineTerminalManagementContext): boolean {
  return context.online && context.localAttendanceVerified &&
    (context.isOwner || (context.isManagerAtBranch && context.hasActiveOwnerDelegation));
}
/** Body for a signed online assignment/change; server derives tenant/branch and audits the actor. */
export type OfflineTerminalAssignment = Readonly<{
  targetTerminalId: string;
  targetEnrollmentId: string;
  expectedNominationVersion: number;
  reason: string;
}>;

export function assertSafeInteger(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid integer amount");
}

/** Validate typed grant bounds; not a JSON parser or a signature verifier. */
export function assertOfflineGrantBounds(grant: OfflineGrant): void {
  for (const value of [grant.issuedAt, grant.notBefore, grant.expiresAt]) assertSafeInteger(value);
  if (grant.issuedAt > grant.notBefore || grant.notBefore >= grant.expiresAt ||
      grant.expiresAt - grant.issuedAt > MAX_OFFLINE_GRANT_MS) throw new Error("Invalid grant lifetime");
  for (const value of [grant.grantVersion, grant.nominationVersion, grant.policyVersion, grant.maxSnapshotAgeAtOutageMs]) {
    assertSafeInteger(value, 1);
  }
  if (grant.maxSnapshotAgeAtOutageMs !== MAX_SNAPSHOT_AGE_AT_OUTAGE_MS) {
    throw new Error("Invalid grant limits");
  }
  if (!grant.registerId || !grant.tillId || grant.authorizedStaff.length === 0) throw new Error("Missing authorized staff or till");
  const staffIds = new Set<string>();
  const staffAuthorizationIds = new Set<string>();
  for (const staff of grant.authorizedStaff) {
    if (!staff.staffUserId || staffIds.has(staff.staffUserId) ||
        !staff.staffAuthorizationId || staff.signInMethod !== "personal_pin" ||
        staffAuthorizationIds.has(staff.staffAuthorizationId)) {
      throw new Error("Invalid authorized staff");
    }
    staffIds.add(staff.staffUserId);
    staffAuthorizationIds.add(staff.staffAuthorizationId);
    assertSafeInteger(staff.credentialVersion, 1);
  }
  for (const window of [...grant.operatingWindows,
    ...(grant.operatingHoursException ? [grant.operatingHoursException] : [])]) {
    assertSafeInteger(window.startsAt);
    assertSafeInteger(window.endsAt);
    if (window.startsAt >= window.endsAt || window.startsAt < grant.notBefore ||
        window.endsAt > grant.expiresAt) throw new Error("Invalid operating window");
  }
  const exception = grant.operatingHoursException;
  if (exception && (!exception.approvalId || !exception.approverUserId || !exception.reason.trim())) {
    throw new Error("Missing operating-hours evidence");
  }
}

/** Structural bounds for a typed, already parsed snapshot; empty/zero balances are valid. */
export function assertStockSnapshotBounds(snapshot: BranchStockSnapshot): void {
  if (snapshot.contractVersion !== 1 || snapshot.kind !== "branch_stock_snapshot" || !snapshot.snapshotId) throw new Error("Invalid snapshot");
  assertSafeInteger(snapshot.snapshotVersion, 1);
  assertSafeInteger(snapshot.generatedAt);
  assertSafeInteger(snapshot.includedThroughSequence);
  if (snapshot.includedThroughSequence === 0 ? snapshot.includedThroughHash !== null :
      !/^[a-f0-9]{64}$/.test(snapshot.includedThroughHash ?? "")) throw new Error("Invalid snapshot watermark");
  const ids = new Set<string>();
  const batches = new Set<string>();
  for (const line of snapshot.lines) {
    if (!line.snapshotLineId || !line.productId || !line.batchId ||
        ids.has(line.snapshotLineId) || batches.has(line.batchId)) throw new Error("Duplicate or missing snapshot identity");
    ids.add(line.snapshotLineId);
    batches.add(line.batchId);
    assertSafeInteger(line.availableQuantity);
    assertSafeInteger(line.unitPriceMinor);
    assertSafeInteger(line.taxBasisPoints);
    assertSafeInteger(line.sellBefore);
    if (line.taxBasisPoints > 10000) throw new Error("Invalid snapshot tax policy");
  }
}

/** A probe succeeding alone does not establish online operation. */
export function terminalConnectivity(probe: { apiReachable: boolean; authenticated: boolean; syncComplete: boolean }): "online" | "partial_outage" {
  return probe.apiReachable && probe.authenticated && probe.syncComplete ? "online" : "partial_outage";
}

/** Apply only after authenticated parsing, signature verification and trusted-clock checks. */
export function offlineGrantTimeError(grant: OfflineGrant, trustedNow: number): TerminalErrorCode | null {
  assertSafeInteger(trustedNow);
  if (trustedNow >= grant.expiresAt) return "GRANT_EXPIRED";
  if (trustedNow < grant.notBefore) return "GRANT_INVALID";
  const windows = [...grant.operatingWindows, ...(grant.operatingHoursException ? [grant.operatingHoursException] : [])];
  return windows.some(w => trustedNow >= w.startsAt && trustedNow < w.endsAt) ? null : "OUTSIDE_OPERATING_HOURS";
}

export type CommittedCommandReceipt = Readonly<{
  identity: TerminalIdentity;
  commandId: string;
  commandHash: string;
  sequence: number;
  committedAt: number;
}> & (
  | (Readonly<{ commandKind: "ordinary_sale"; saleId: string }> & StockPostingOutcome)
  | Readonly<{ commandKind: "shift_open" | "shift_close"; workSessionId: string }>
);

/** Called on an authenticated enrolled-device request; receipt lookup is tenant/enrollment scoped. */
export function classifyCommandReplay(
  receipt: CommittedCommandReceipt | null,
  incoming: Pick<CommittedCommandReceipt, "identity" | "commandId" | "commandHash" | "sequence">,
): "new" | "duplicate" | "conflict" {
  if (!receipt) return "new";
  const identityKeys: ReadonlyArray<keyof TerminalIdentity> = ["tenantId", "branchId", "terminalId", "enrollmentId", "keyId"];
  return identityKeys.every(k => receipt.identity[k] === incoming.identity[k]) &&
    receipt.commandId === incoming.commandId && receipt.commandHash === incoming.commandHash &&
    receipt.sequence === incoming.sequence ? "duplicate" : "conflict";
}

/** Checks verified local PIN sign-in evidence; actual PIN verification is performed in main. */
function offlineStaffSessionError(
  grant: OfflineGrant, command: OfflineCommandContext, signIn: OfflineStaffSignIn, trustedNow: number,
): TerminalErrorCode | null {
  const identityKeys: ReadonlyArray<keyof TerminalIdentity> = ["tenantId", "branchId", "terminalId", "enrollmentId", "keyId"];
  const sessionKeys: ReadonlyArray<keyof WorkSessionIdentity> = ["registerId", "tillId", "workSessionId", "staffUserId"];
  const staff = grant.authorizedStaff.find(s => s.staffUserId === command.session.staffUserId);
  if (!staff || !command.session.workSessionId || command.session.registerId !== grant.registerId ||
      command.session.tillId !== grant.tillId) return "SESSION_INVALID";
  if (signIn.contractVersion !== 1 || signIn.kind !== "offline_staff_sign_in" ||
      !command.staffSignInId || command.staffSignInId !== signIn.staffSignInId ||
      identityKeys.some(k => signIn.identity[k] !== grant.identity[k]) ||
      sessionKeys.some(k => signIn.session[k] !== command.session[k]) ||
      signIn.grantId !== grant.grantId || signIn.grantVersion !== grant.grantVersion ||
      signIn.staffAuthorizationId !== staff.staffAuthorizationId ||
      signIn.credentialVersion !== staff.credentialVersion || signIn.method !== "personal_pin" ||
      !Number.isSafeInteger(signIn.authenticatedAt) || signIn.authenticatedAt < grant.notBefore ||
      signIn.authenticatedAt > trustedNow) return "SESSION_INVALID";
  return null;
}

export type OfflineTillShiftState = Readonly<{
  openShift: LocalOpenTillShift | null;
  expectedCashMinor: number | null; // maintained atomically with net cash sales in P4
  lastClosedWorkSessionId: string | null;
  usedWorkSessionIds: ReadonlyArray<string>;
}>;
export type OfflineShiftClosingSummary = Readonly<{
  session: WorkSessionIdentity;
  closedAt: number;
  expectedCashMinor: number;
  closingCashCountMinor: number;
  varianceMinor: number;
  syncStatus: "pending";
}>;

/** P0 lifecycle policy only: caller verifies signatures/chain and persists command + shift atomically.
 * Does not create accounts/credentials, move cash, settle a discrepancy or reset terminal usage.
 */
export function offlineShiftTransition(
  grant: OfflineGrant,
  command: OfflineShiftOpenCommand | OfflineShiftCloseCommand,
  current: OfflineTillShiftState,
  signIn: OfflineStaffSignIn,
  trustedNow: number,
  terminalState: OfflineTerminalState,
): Readonly<{ error: TerminalErrorCode | null; next: OfflineTillShiftState; closingSummary: OfflineShiftClosingSummary | null }> {
  const fail = (error: TerminalErrorCode) => ({ error, next: current, closingSummary: null });
  try { assertOfflineGrantBounds(grant); }
  catch { return fail("GRANT_INVALID"); }
  if (terminalState === "revoked") return fail("TERMINAL_REVOKED");
  if (terminalState !== "offline") return fail("ONLINE_REQUIRED");
  if (command.contractVersion !== 1 || (command.kind !== "shift_open" && command.kind !== "shift_close")) return fail("INVALID_COMMAND");
  if (command.grantId !== grant.grantId || command.grantVersion !== grant.grantVersion ||
      command.nominationVersion !== grant.nominationVersion) return fail("GRANT_INVALID");
  const identityKeys: ReadonlyArray<keyof TerminalIdentity> = ["tenantId", "branchId", "terminalId", "enrollmentId", "keyId"];
  if (identityKeys.some(k => command.identity[k] !== grant.identity[k])) return fail("IDENTITY_MISMATCH");
  try {
    assertSafeInteger(trustedNow);
    assertSafeInteger(command.offlineStartedAt);
    assertSafeInteger(command.sequence, 1);
  } catch { return fail("INVALID_COMMAND"); }
  if (command.occurredAt !== trustedNow || command.offlineStartedAt < grant.notBefore ||
      command.offlineStartedAt > trustedNow) return fail("CLOCK_UNTRUSTED");
  const timeError = offlineGrantTimeError(grant, trustedNow);
  // Approved D8: after-hours cash counting/closing is allowed; sales/opening still need a window.
  if (timeError && !(command.kind === "shift_close" && timeError === "OUTSIDE_OPERATING_HOURS")) return fail(timeError);
  if (!command.commandId || !command.offlineSessionId || command.currency !== "LKR" ||
      (command.sequence === 1 ? command.previousCommandHash !== null :
        !/^[a-f0-9]{64}$/.test(command.previousCommandHash ?? ""))) return fail("INVALID_COMMAND");
  const staffError = offlineStaffSessionError(grant, command, signIn, trustedNow);
  if (staffError) return fail(staffError);
  if (command.kind === "shift_open") {
    if (current.openShift || current.usedWorkSessionIds.includes(command.session.workSessionId) ||
        command.previousClosedWorkSessionId !== current.lastClosedWorkSessionId) return fail("SESSION_INVALID");
    try { assertSafeInteger(command.openingCashMinor); }
    catch { return fail("INVALID_COMMAND"); }
    return { error: null, closingSummary: null, next: {
      openShift: { identity: command.identity, session: command.session, openedAt: trustedNow, openingCashMinor: command.openingCashMinor },
      expectedCashMinor: command.openingCashMinor,
      lastClosedWorkSessionId: current.lastClosedWorkSessionId,
      usedWorkSessionIds: [...current.usedWorkSessionIds, command.session.workSessionId],
    } };
  }
  const open = current.openShift;
  const sessionKeys: ReadonlyArray<keyof WorkSessionIdentity> = ["registerId", "tillId", "workSessionId", "staffUserId"];
  if (!open || identityKeys.some(k => open.identity[k] !== grant.identity[k]) ||
      sessionKeys.some(k => open.session[k] !== command.session[k]) || trustedNow < open.openedAt) return fail("SESSION_INVALID");
  try { assertSafeInteger(command.closingCashCountMinor); assertSafeInteger(command.expectedCashMinor); }
  catch { return fail("INVALID_COMMAND"); }
  if (command.expectedCashMinor !== current.expectedCashMinor) return fail("INVALID_COMMAND");
  return { error: null, closingSummary: {
    session: command.session, closedAt: trustedNow, expectedCashMinor: command.expectedCashMinor,
    closingCashCountMinor: command.closingCashCountMinor,
    varianceMinor: command.closingCashCountMinor - command.expectedCashMinor, syncStatus: "pending",
  }, next: { openShift: null, expectedCashMinor: null,
    lastClosedWorkSessionId: command.session.workSessionId, usedWorkSessionIds: current.usedWorkSessionIds } };
}

export type OfflineUsage = Readonly<{
  grantId: string;
  grantVersion: number;
  snapshotId: string;
  snapshotVersion: number;
  offlineSessionId: string;
  offlineStartedAt: number;
  quantities: Readonly<Record<string, number>>; // net consumption since snapshot, including online sales not in watermark
}>;

/** Pure policy check, NOT authorization. Trusted main process supplies verified grant,
 * trusted time and durable usage. P4 must commit sale, usage and journal atomically.
 */
export function offlineSalePolicyError(
  grant: OfflineGrant,
  snapshot: BranchStockSnapshot,
  sale: OfflineSaleCommand,
  usage: OfflineUsage,
  trustedNow: number,
  state: OfflineTerminalState,
  staffSignIn: OfflineStaffSignIn,
  openShift: LocalOpenTillShift | null,
): TerminalErrorCode | null {
  try {
    assertOfflineGrantBounds(grant);
    assertSafeInteger(trustedNow);
  } catch { return "GRANT_INVALID"; }
  try { assertStockSnapshotBounds(snapshot); }
  catch { return "SNAPSHOT_INVALID"; }
  try {
    assertSafeInteger(usage.offlineStartedAt);
    Object.values(usage.quantities).forEach(q => assertSafeInteger(q));
  } catch { return "INVALID_COMMAND"; }
  if (state === "revoked") return "TERMINAL_REVOKED";
  if (state !== "offline") return "ONLINE_REQUIRED";
  if (sale.contractVersion !== 1 || grant.contractVersion !== 1) return "UNSUPPORTED_CONTRACT";
  if (sale.kind !== "ordinary_sale" || grant.kind !== "offline_grant") return "INVALID_COMMAND";
  const identityKeys: ReadonlyArray<keyof TerminalIdentity> = ["tenantId", "branchId", "terminalId", "enrollmentId", "keyId"];
  if (identityKeys.some(k => sale.identity[k] !== grant.identity[k] || snapshot.identity[k] !== grant.identity[k])) return "IDENTITY_MISMATCH";
  const sessionKeys: ReadonlyArray<keyof WorkSessionIdentity> = ["registerId", "tillId", "workSessionId", "staffUserId"];
  const staffError = offlineStaffSessionError(grant, sale, staffSignIn, trustedNow);
  if (staffError) return staffError;
  if (!openShift || identityKeys.some(k => openShift.identity[k] !== grant.identity[k]) ||
      sessionKeys.some(k => openShift.session[k] !== sale.session[k]) ||
      !Number.isSafeInteger(openShift.openedAt) || openShift.openedAt > trustedNow) return "SESSION_INVALID";
  if (sale.grantId !== grant.grantId || sale.grantVersion !== grant.grantVersion ||
      usage.grantId !== grant.grantId || usage.grantVersion !== grant.grantVersion ||
      sale.nominationVersion !== grant.nominationVersion) return "GRANT_INVALID";
  if (sale.snapshotId !== snapshot.snapshotId || sale.snapshotVersion !== snapshot.snapshotVersion ||
      usage.snapshotId !== snapshot.snapshotId || usage.snapshotVersion !== snapshot.snapshotVersion ||
      !sale.offlineSessionId || sale.offlineSessionId !== usage.offlineSessionId ||
      sale.offlineStartedAt !== usage.offlineStartedAt) return "SNAPSHOT_MISMATCH";
  if (usage.offlineStartedAt < snapshot.generatedAt || usage.offlineStartedAt > trustedNow ||
      usage.offlineStartedAt < grant.notBefore) return "CLOCK_UNTRUSTED";
  if (usage.offlineStartedAt - snapshot.generatedAt > grant.maxSnapshotAgeAtOutageMs) return "SNAPSHOT_STALE";
  const timeError = offlineGrantTimeError(grant, trustedNow);
  if (timeError) return timeError;
  if (sale.occurredAt !== trustedNow) return "CLOCK_UNTRUSTED";
  if (sale.currency !== "LKR" || grant.currency !== "LKR") return "INVALID_COMMAND";
  try {
    assertSafeInteger(sale.sequence, 1);
    if (sale.sequence <= snapshot.includedThroughSequence) return "INVALID_COMMAND";
    assertSafeInteger(sale.totalMinor);
    if (!sale.commandId || (sale.sequence === 1 ? sale.previousCommandHash !== null :
      !/^[a-f0-9]{64}$/.test(sale.previousCommandHash ?? ""))) return "INVALID_COMMAND";
    if (!sale.lines.length || !sale.payments.length) return "INVALID_COMMAND";
    let total = 0;
    const seen = new Set<string>();
    for (const line of sale.lines) {
      assertSafeInteger(line.quantity, 1);
      assertSafeInteger(line.unitPriceMinor);
      assertSafeInteger(line.discountMinor);
      assertSafeInteger(line.taxMinor);
      if (seen.has(line.snapshotLineId)) return "INVALID_COMMAND";
      seen.add(line.snapshotLineId);
      const known = snapshot.lines.find(l => l.snapshotLineId === line.snapshotLineId);
      if (!known) return "SNAPSHOT_MISMATCH";
      if (known.stockReviewRequired) return "RECONCILIATION_REQUIRED";
      if (trustedNow >= known.sellBefore) return "ONLINE_REQUIRED";
      const consumed = (usage.quantities[line.snapshotLineId] ?? 0) + line.quantity;
      assertSafeInteger(consumed);
      if (consumed > known.availableQuantity) return "LOCAL_STOCK_EXHAUSTED";
      // Approved D6: keep original signed snapshot prices; no offline discounts/overrides.
      if (line.unitPriceMinor !== known.unitPriceMinor || line.discountMinor !== 0) return "INVALID_COMMAND";
      const net = line.quantity * line.unitPriceMinor;
      assertSafeInteger(net);
      // Exact half-up rounding of tax per line, never binary floating-point currency math.
      const tax = Number((BigInt(net) * BigInt(known.taxBasisPoints) + 5000n) / 10000n);
      assertSafeInteger(tax);
      if (line.taxMinor !== tax) return "INVALID_COMMAND";
      total += net + tax;
      assertSafeInteger(total);
    }
    if (total !== sale.totalMinor) return "INVALID_COMMAND";
    let paid = 0;
    for (const payment of sale.payments) {
      assertSafeInteger(payment.amountMinor);
      if (payment.method === "cash") {
        assertSafeInteger(payment.tenderedMinor);
        assertSafeInteger(payment.changeMinor);
        if (payment.tenderedMinor - payment.changeMinor !== payment.amountMinor) return "INVALID_COMMAND";
      } else if (payment.method === "external_card") {
        assertSafeInteger(payment.approvedAt);
        if (!grant.externalCardAllowed || !payment.providerReference.trim() || !payment.approvalCode.trim() ||
            payment.approvedAt > trustedNow || payment.approvedAt < grant.notBefore) return "PAYMENT_NOT_ALLOWED";
      } else { return "PAYMENT_NOT_ALLOWED"; }
      paid += payment.amountMinor;
      assertSafeInteger(paid);
    }
    return paid === total ? null : "INVALID_COMMAND";
  } catch { return "INVALID_COMMAND"; }
}
