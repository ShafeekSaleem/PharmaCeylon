/** P0 Decision 10 revision: remote management/approval, accountable local execution.
 * These are typed policy fixtures, not installed API guards or runtime JSON validators.
 */
export const ONLINE_OPERATION_EFFECTS = [
  "management_record",
  "business_reservation",
  "bank_payment_record",
  "physical_stock",
  "branch_cash",
  "customer_refund_execution",
  "clinical_dispensing",
  "terminal_designation",
] as const;
export type OnlineOperationEffect = typeof ONLINE_OPERATION_EFFECTS[number];

export type OperationPolicyErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "PERMISSION_DENIED"
  | "IDENTITY_MISMATCH"
  | "ONLINE_REQUIRED"
  | "TERMINAL_REQUIRED"
  | "REMOTE_SESSION_DENIED"
  | "PHARMACIST_REQUIRED"
  | "PAYMENT_EVIDENCE_REQUIRED"
  | "INVALID_COMMAND"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_INVALID"
  | "APPROVAL_STALE"
  | "APPROVAL_EXPIRED"
  | "SELF_APPROVAL_DENIED";

/** Derive these facts from authenticated server state and verified execution context.
 * Effects are declared by the server for the complete transaction, never chosen by a client.
 */
export type OnlineOperationAccessContext = Readonly<{
  online: boolean;
  authenticated: boolean;
  branchAccessVerified: boolean;
  permissionGranted: boolean;
  terminalEnrolled: boolean;
  enrollmentBranchMatches: boolean;
  localAttendanceVerified: boolean;
  clinicalEvidenceVerified: boolean;
  bankPaymentEvidenceVerified: boolean;
}>;

const LOCAL_EXECUTION_EFFECTS: ReadonlySet<OnlineOperationEffect> = new Set([
  "physical_stock", "branch_cash", "customer_refund_execution", "clinical_dispensing", "terminal_designation",
]);

/** A mixed operation inherits every effect's restriction; an approval label cannot hide posting. */
export function onlineOperationAccessError(
  effects: ReadonlyArray<OnlineOperationEffect>,
  context: OnlineOperationAccessContext,
): OperationPolicyErrorCode | null {
  if (!effects.length || effects.some(effect => !ONLINE_OPERATION_EFFECTS.includes(effect))) return "INVALID_COMMAND";
  if (!context.online) return "ONLINE_REQUIRED";
  if (!context.authenticated) return "AUTHENTICATION_REQUIRED";
  if (!context.branchAccessVerified) return "IDENTITY_MISMATCH";
  if (!context.permissionGranted) return "PERMISSION_DENIED";
  if (effects.some(effect => LOCAL_EXECUTION_EFFECTS.has(effect))) {
    if (!context.terminalEnrolled) return "TERMINAL_REQUIRED";
    if (!context.enrollmentBranchMatches) return "IDENTITY_MISMATCH";
    if (!context.localAttendanceVerified) return "REMOTE_SESSION_DENIED";
  }
  if (effects.includes("clinical_dispensing") && !context.clinicalEvidenceVerified) return "PHARMACIST_REQUIRED";
  if (effects.includes("bank_payment_record") && !context.bankPaymentEvidenceVerified) return "PAYMENT_EVIDENCE_REQUIRED";
  return null;
}

export type ApprovalDocumentIdentity = Readonly<{
  tenantId: string;
  branchId: string;
  documentType: string;
  documentId: string;
  documentVersion: number;
  documentDigest: string; // SHA-256 of the canonical relevant document, not a caller's summary
  requestedByUserId: string;
}>;

/** Immutable, server-persisted authorization. Does not itself post stock, cash or a refund. */
export type ManagementApprovalEvidence = Readonly<{
  approvalId: string;
  document: ApprovalDocumentIdentity;
  authorizedAction: string; // exact scoped domain action; generic approval cannot authorize another action
  approvedByUserId: string;
  approvedAt: number;
  expiresAt: number | null; // no new mandatory approval TTL; existing workflow policy determines this
  status: "approved" | "revoked";
  policyVersion: number;
  reason: string;
}>;

/** Standard online user auth/CSRF and permissions apply; a management request needs no terminal key.
 * Tenant/branch and current document identity are independently resolved/checked by the API.
 */
export type OnlineManagementCommand<T> = Readonly<{
  contractVersion: 1;
  kind: "management_operation";
  commandId: string;
  operation: string;
  document: ApprovalDocumentIdentity | null; // null for initial creation or non-document administration
  body: T;
}>;

export type ApprovalExecutionAttribution = Readonly<{
  approvalId: string;
  approvedByUserId: string;
  executedByUserId: string;
  document: ApprovalDocumentIdentity;
  terminalId: string;
  enrollmentId: string;
  workSessionId: string;
  executionCommandId: string;
  executedAt: number;
}>;

export type ApprovalUseContext = Readonly<{
  currentDocument: ApprovalDocumentIdentity;
  authorizedAction: string;
  trustedNow: number;
  approverStillAuthorized: boolean;
  mayApproveOwnRequests: boolean; // derived from existing branch self-approval rules
}>;

/** Compare server-fetched evidence with the current document inside the execution transaction.
 * Domain quantity/refund limits, concurrency control and execution idempotency still apply.
 * A requester approving their own request is distinct from an approver also acting as executor.
 */
export function approvalUseError(
  approval: ManagementApprovalEvidence | null,
  context: ApprovalUseContext,
): OperationPolicyErrorCode | null {
  if (!approval) return "APPROVAL_REQUIRED";
  const approved = approval.document;
  const current = context.currentDocument;
  if (!approval.approvalId || !approval.approvedByUserId || !approval.authorizedAction ||
      !Number.isSafeInteger(approval.approvedAt) || approval.approvedAt < 0 ||
      !Number.isSafeInteger(approval.policyVersion) || approval.policyVersion < 1 ||
      !Number.isSafeInteger(context.trustedNow) || context.trustedNow < approval.approvedAt ||
      !Number.isSafeInteger(approved.documentVersion) || approved.documentVersion < 1 ||
      !Number.isSafeInteger(current.documentVersion) || current.documentVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(approved.documentDigest) || !/^[a-f0-9]{64}$/.test(current.documentDigest) ||
      approval.status !== "approved" || !context.approverStillAuthorized) return "APPROVAL_INVALID";
  const identityKeys: ReadonlyArray<keyof ApprovalDocumentIdentity> = [
    "tenantId", "branchId", "documentType", "documentId", "requestedByUserId",
  ];
  if (identityKeys.some(key => !approved[key] || !current[key] || approved[key] !== current[key]) ||
      approval.authorizedAction !== context.authorizedAction) return "APPROVAL_INVALID";
  if (approved.documentVersion !== current.documentVersion || approved.documentDigest !== current.documentDigest) return "APPROVAL_STALE";
  if (approval.expiresAt !== null) {
    if (!Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= approval.approvedAt) return "APPROVAL_INVALID";
    if (context.trustedNow >= approval.expiresAt) return "APPROVAL_EXPIRED";
  }
  if (approved.requestedByUserId === approval.approvedByUserId && !context.mayApproveOwnRequests) return "SELF_APPROVAL_DENIED";
  return null;
}
