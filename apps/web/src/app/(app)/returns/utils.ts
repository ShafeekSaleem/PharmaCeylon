import type { AuthUser } from "@/lib/auth-types";
import {
  formatDate,
  formatDateTime,
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
  type GoodsReturnStatus,
  type GoodsReturnStatusFilter,
  type GoodsReturnType,
  type ReturnListItem,
  type SummaryPeriod,
} from "./types";

export {
  formatDate,
  formatDateTime,
  formatMoney,
  isDateInSummaryPeriod,
  parseDateOnlyLocal,
  resolveSummaryPeriod,
  startOfMonthIso,
  todayIsoDate,
};

export function hasReturnWriteAccess(
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

export function canApproveReturn(
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

export function formatReturnNo(row: Pick<ReturnListItem, "returnNumber" | "id">): string {
  if (row.returnNumber?.trim()) return row.returnNumber.trim();
  const num = parseInt(row.id.replace(/-/g, "").slice(0, 10), 16) % 100000;
  return `RET-${String(num).padStart(5, "0")}`;
}

export function returnLineCount(items: { qty: number }[]): number {
  return items.reduce((sum, line) => sum + line.qty, 0);
}

export function returnPartyLabel(row: ReturnListItem): string {
  if (row.type === "customer") {
    return row.customerName?.trim() || row.sale?.invoiceNo || "Customer";
  }
  return row.supplier?.name ?? "Supplier";
}

export function displayStatusLabel(
  status: GoodsReturnStatus | string,
  type?: GoodsReturnType,
): string {
  switch (status) {
    case "pending_approval":
      return "Pending approval";
    case "awaiting_logistics":
      if (type === "customer") return "Awaiting pickup";
      if (type === "supplier") return "Awaiting dispatch";
      return "Awaiting pickup/dispatch";
    case "in_review":
      return "In review";
    case "draft":
      return "Draft";
    case "completed":
      return "Completed";
    case "rejected":
      return "Rejected";
    case "cancelled":
      return "Cancelled";
    default:
      return String(status).replace(/_/g, " ");
  }
}

/** Status key passed to StatusBadge (unified awaiting label). */
export function displayStatus(row: Pick<ReturnListItem, "status">): string {
  return row.status;
}

export function matchesStatusFilter(
  row: ReturnListItem,
  filter: GoodsReturnStatusFilter,
): boolean {
  if (filter === "all") return true;
  return row.status === filter;
}

export function canSubmit(status: GoodsReturnStatus): boolean {
  return status === "draft";
}

export function canApprove(status: GoodsReturnStatus): boolean {
  return status === "pending_approval";
}

export function canReject(status: GoodsReturnStatus): boolean {
  return status === "pending_approval";
}

export function canMarkLogistics(status: GoodsReturnStatus): boolean {
  return status === "awaiting_logistics";
}

export function canComplete(status: GoodsReturnStatus): boolean {
  return status === "in_review" || status === "awaiting_logistics";
}

export function canCancel(status: GoodsReturnStatus): boolean {
  return status === "draft" || status === "pending_approval";
}

export function canCancelReturn(
  user: AuthUser | null,
  row: Pick<ReturnListItem, "requestedBy" | "status" | "branchId">,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (!canCancel(row.status)) return false;
  if (branchId && row.branchId !== branchId) return false;
  if (user.id === row.requestedBy) return true;
  return canApproveReturn(user, branchId ?? row.branchId);
}

export function amountNumber(value: string | number | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function periodSummaryFromReturns(rows: ReturnListItem[], period: SummaryPeriod) {
  const inPeriod = rows.filter((row) => isDateInSummaryPeriod(row.createdAt, period));
  let totalValue = 0;
  let refundedCustomer = 0;
  let supplierCredits = 0;

  for (const row of inPeriod) {
    if (row.status === "cancelled" || row.status === "rejected") continue;
    const amt = amountNumber(row.amount);
    totalValue += amt;
    if (row.type === "customer") refundedCustomer += amt;
    else supplierCredits += amt;
  }

  return {
    totalValue,
    refundedCustomer,
    supplierCredits,
    net: refundedCustomer - supplierCredits,
    returnCount: inPeriod.length,
  };
}
