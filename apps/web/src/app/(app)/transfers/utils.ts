import type { AuthUser } from "@/lib/auth-types";
import {
  formatDate,
  formatMoney,
  isDateInSummaryPeriod,
  parseDateOnlyLocal,
  resolveSummaryPeriod,
  startOfMonthIso,
  todayIsoDate,
} from "../purchasing/utils";
import {
  APPROVE_ROLES,
  WRITE_ROLES,
  type SummaryPeriod,
  type TransferListItem,
  type TransferStatus,
  type TransferStatusFilter,
} from "./types";

export {
  formatDate,
  formatMoney,
  isDateInSummaryPeriod,
  parseDateOnlyLocal,
  resolveSummaryPeriod,
  startOfMonthIso,
  todayIsoDate,
};

export function hasTransferWriteAccess(
  user: AuthUser | null,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (user.branchRoles.some((br) => br.role === "owner")) return true;
  const scoped = branchId
    ? user.branchRoles.filter((br) => br.branchId === branchId)
    : user.branchRoles;
  return scoped.some((br) => WRITE_ROLES.has(br.role));
}

export function canApproveTransfer(
  user: AuthUser | null,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (user.branchRoles.some((br) => br.role === "owner")) return true;
  const scoped = branchId
    ? user.branchRoles.filter((br) => br.branchId === branchId)
    : user.branchRoles;
  return scoped.some((br) => APPROVE_ROLES.has(br.role));
}

export function canCancelTransfer(
  user: AuthUser | null,
  transfer: Pick<TransferListItem, "requestedBy" | "status" | "fromBranchId">,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (transfer.status !== "requested" && transfer.status !== "approved") return false;
  if (branchId && transfer.fromBranchId !== branchId) return false;
  if (user.id === transfer.requestedBy) return true;
  return canApproveTransfer(user, branchId ?? transfer.fromBranchId);
}

export function formatTransferNo(row: Pick<TransferListItem, "transferNumber">): string {
  return row.transferNumber;
}

export function transferLineCount(items: { qty: number }[]): number {
  return items.reduce((sum, line) => sum + line.qty, 0);
}

export function transferReceivedLineCount(items: { receivedQty?: number }[]): number {
  return items.reduce((sum, line) => sum + (line.receivedQty ?? 0), 0);
}

const OVERDUE_FALLBACK_DAYS = 7;

export function isTransferOverdue(
  row: Pick<TransferListItem, "status" | "updatedAt" | "expectedOn">,
): boolean {
  if (row.status !== "in_transit" && row.status !== "partially_received") return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (row.expectedOn) {
    const expected = parseDateOnlyLocal(row.expectedOn);
    if (expected) {
      expected.setHours(0, 0, 0, 0);
      return expected < today;
    }
  }

  const updated = new Date(row.updatedAt);
  if (Number.isNaN(updated.getTime())) return false;
  const limit = new Date();
  limit.setDate(limit.getDate() - OVERDUE_FALLBACK_DAYS);
  return updated < limit;
}

export function displayTransferStatus(
  row: Pick<TransferListItem, "status" | "updatedAt" | "expectedOn">,
): string {
  if (isTransferOverdue(row)) return "overdue";
  return row.status;
}

export function formatTransferStatusLabel(status: string): string {
  if (status === "overdue") return "Overdue";
  if (status === "requested") return "Pending approval";
  if (status === "approved") return "Ready to ship";
  if (status === "in_transit") return "In transit";
  if (status === "partially_received") return "Partially received";
  if (status === "received") return "Completed";
  return status.replace(/_/g, " ");
}

export function receivedPercent(row: TransferListItem): number {
  if (typeof row.receivedPercent === "number" && !Number.isNaN(row.receivedPercent)) {
    return row.receivedPercent;
  }
  if (row.status === "received") return 100;
  const total = row.totalQty ?? transferLineCount(row.items);
  const received =
    row.receivedQty ??
    transferReceivedLineCount(row.items);
  if (total > 0 && received > 0) {
    return Math.min(100, Math.round((received / total) * 100));
  }
  return 0;
}

export function receivedProgressTone(
  row: TransferListItem,
  overdue: boolean,
): "danger" | "done" | "warn" | "none" {
  if (overdue) return "danger";
  const pct = receivedPercent(row);
  if (pct >= 100) return "done";
  if (pct > 0) return "warn";
  if ((row.dispatchedQty ?? 0) > 0 || row.status === "in_transit") return "warn";
  return "none";
}

export function matchesStatusFilter(
  row: TransferListItem,
  filter: TransferStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "overdue") return isTransferOverdue(row);
  if (filter === "cancelled") return row.status === "cancelled" || row.status === "rejected";
  return row.status === filter;
}

export function canApprove(status: TransferStatus): boolean {
  return status === "requested";
}

export function canReject(status: TransferStatus): boolean {
  return status === "requested";
}

export function canCancel(status: TransferStatus): boolean {
  return status === "requested" || status === "approved";
}

export function canShip(status: TransferStatus, fromBranchId: string, branchId: string): boolean {
  return status === "approved" && fromBranchId === branchId;
}

export function canReceive(
  status: TransferStatus,
  toBranchId: string,
  branchId: string,
): boolean {
  return (
    (status === "in_transit" || status === "partially_received") &&
    toBranchId === branchId
  );
}

/** True when the transfer is awaiting receipt, regardless of active branch. */
export function isAwaitingReceipt(status: TransferStatus): boolean {
  return status === "in_transit" || status === "partially_received";
}

/** True when ready to ship but active branch is not the source. */
export function needsSourceBranchToShip(
  status: TransferStatus,
  fromBranchId: string,
  branchId: string | null,
): boolean {
  return status === "approved" && !!branchId && fromBranchId !== branchId;
}

/** Pending approval/reject/cancel actions require the source branch. */
export function needsSourceBranchForSourceActions(
  status: TransferStatus,
  fromBranchId: string,
  branchId: string | null,
): boolean {
  return (
    (status === "requested" || status === "approved") &&
    !!branchId &&
    fromBranchId !== branchId
  );
}

/** True when awaiting receipt but active branch is not the destination. */
export function needsDestinationBranchToReceive(
  status: TransferStatus,
  toBranchId: string,
  branchId: string | null,
): boolean {
  return isAwaitingReceipt(status) && !!branchId && toBranchId !== branchId;
}

export function periodSummaryFromTransfers(
  rows: TransferListItem[],
  period: SummaryPeriod,
) {
  const inPeriod = rows.filter((row) => isDateInSummaryPeriod(row.createdAt, period));
  let totalSent = 0;
  let totalReceived = 0;
  let inTransit = 0;

  for (const row of inPeriod) {
    const qty = transferLineCount(row.items);
    const received = transferReceivedLineCount(row.items);
    if (row.status === "cancelled" || row.status === "rejected") continue;

    if (row.status === "received") {
      totalSent += qty;
      totalReceived += qty;
    } else if (row.status === "partially_received") {
      totalSent += qty;
      totalReceived += received;
      inTransit += qty - received;
    } else if (row.status === "in_transit") {
      totalSent += qty;
      inTransit += qty;
    }
    // requested / approved are not yet dispatched — exclude from sent/in-transit stats
  }

  return {
    totalSent,
    totalReceived,
    inTransit,
    net: totalReceived,
    transferCount: inPeriod.length,
  };
}
