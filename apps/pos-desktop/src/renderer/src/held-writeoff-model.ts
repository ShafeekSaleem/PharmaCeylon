import type { CounterWorkItem, HeldWriteOffAtCounter } from "../../shared/ipc-contract";
export type HeldWriteOffUiStatus =
  | "awaiting_approval"
  | "approved"
  | "accepted"
  | "rejected";

export function heldStatus(
  item: CounterWorkItem,
  detail: HeldWriteOffAtCounter | null,
): HeldWriteOffUiStatus {
  const fromItem = item.heldAdjustmentStatus;
  if (fromItem) return fromItem;
  if (detail?.status) return detail.status;
  if (item.approval.evidenceId) return "approved";
  return "awaiting_approval";
}

export function canPostHeldWriteOff(
  status: HeldWriteOffUiStatus,
  item: CounterWorkItem,
  online: boolean,
): boolean {
  if (!online) return false;
  if (status !== "approved") return false;
  return (
    !item.approval.state ||
    item.approval.state === "matches" ||
    item.approval.state === "not_needed"
  );
}

export function isReadOnlyHeldWriteOff(status: HeldWriteOffUiStatus): boolean {
  return status === "awaiting_approval" || status === "rejected";
}

export function buildHeldPostBody(heldAdjustmentId: string): { heldAdjustmentId: string } {
  return { heldAdjustmentId };
}

/** Stale approval from post/prepare; cleared on next successful list refresh when approval matches. */
export function staleApprovalMessage(code: string | undefined, message: string): string | null {
  if (code === "APPROVAL_STALE" || code === "APPROVAL_INVALID")
    return message || "This approval is no longer valid. A manager needs to accept the request again on the web.";
  if (
    message.toLowerCase().includes("approval changed") ||
    message.toLowerCase().includes("refresh and review")
  )
    return message;
  return null;
}

export function shouldClearStaleError(
  staleMessage: string | null,
  item: CounterWorkItem | null,
): boolean {
  if (!staleMessage || !item) return false;
  return item.approval.state === "matches" || item.approval.state === "not_needed";
}

export function approvalEvidenceIdForPost(
  detail: HeldWriteOffAtCounter | null,
  item: CounterWorkItem,
): string | null {
  return detail?.executionApprovalId ?? item.approval.evidenceId;
}
