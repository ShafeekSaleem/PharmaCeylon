import type { AuthUser } from "@/lib/auth-types";
import {
  WRITE_ROLES,
  type CreatePoLine,
  type PoStatus,
  type PurchaseOrderDetail,
  type PurchaseOrderItem,
  type PurchaseOrderListItem,
} from "./types";
import type { SummaryPeriod } from "./types";

export function resolveSummaryPeriod(period: SummaryPeriod): {
  from: Date;
  to: Date;
  label: string;
} {
  const now = new Date();
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  switch (period) {
    case "last_7_days":
      from.setDate(from.getDate() - 6);
      return { from, to, label: "Last 7 days" };
    case "last_30_days":
      from.setDate(from.getDate() - 29);
      return { from, to, label: "Last 30 days" };
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return {
        from: start,
        to: end,
        label: start.toLocaleString(undefined, { month: "long", year: "numeric" }),
      };
    }
    case "this_quarter": {
      const q = Math.floor(now.getMonth() / 3);
      const start = new Date(now.getFullYear(), q * 3, 1);
      return { from: start, to, label: `Q${q + 1} ${now.getFullYear()}` };
    }
    case "this_year": {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: start, to, label: String(now.getFullYear()) };
    }
    case "this_month":
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        from: start,
        to,
        label: start.toLocaleString(undefined, { month: "long", year: "numeric" }),
      };
    }
  }
}

export function isDateInSummaryPeriod(
  iso: string | null | undefined,
  period: SummaryPeriod,
): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const { from, to } = resolveSummaryPeriod(period);
  return d >= from && d <= to;
}

export function hasPurchasingWriteAccess(
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

export function formatPoStatus(status: PoStatus | string): string {
  return status.replace(/_/g, " ");
}

/** Parse YYYY-MM-DD (or leading date of an ISO string) as a local calendar date. */
export function parseDateOnlyLocal(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatMoney(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (Number.isNaN(n)) return "—";
  return `LKR ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const trimmed = iso.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? parseDateOnlyLocal(trimmed)
    : new Date(trimmed);
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function poLineCount(items: { orderedQty: number }[]): number {
  return items.reduce((sum, i) => sum + i.orderedQty, 0);
}

export function lineMoneyParts(input: {
  orderedQty: number;
  unitCost: string | number;
  discountPercent?: string | number;
  taxPercent?: string | number;
}) {
  const qty = Number(input.orderedQty) || 0;
  const unitCost = Number(input.unitCost) || 0;
  const discountPercent = Number(input.discountPercent ?? 0) || 0;
  const taxPercent = Number(input.taxPercent ?? 0) || 0;
  const base = qty * unitCost;
  const discount = base * (discountPercent / 100);
  const net = base - discount;
  const tax = net * (taxPercent / 100);
  return { base, discount, net, tax, total: net + tax };
}

export function poEstimatedValue(
  items: {
    orderedQty: number;
    unitCost: string | number;
    discountPercent?: string | number;
    taxPercent?: string | number;
  }[],
  shippingCharges: string | number = 0,
): number {
  const lines = items.reduce((sum, i) => sum + lineMoneyParts(i).total, 0);
  return lines + (Number(shippingCharges) || 0);
}

export function poTotals(
  items: CreatePoLine[] | PurchaseOrderItem[],
  shippingCharges: string | number = 0,
) {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const item of items) {
    const qty =
      "orderedQty" in item && typeof item.orderedQty === "string"
        ? Number(item.orderedQty)
        : Number(item.orderedQty);
    const parts = lineMoneyParts({
      orderedQty: qty,
      unitCost: item.unitCost,
      discountPercent: item.discountPercent,
      taxPercent: item.taxPercent,
    });
    subtotal += parts.base;
    discountTotal += parts.discount;
    taxTotal += parts.tax;
  }
  const shipping = Number(shippingCharges) || 0;
  return {
    subtotal,
    discountTotal,
    taxTotal,
    shipping,
    grandTotal: subtotal - discountTotal + taxTotal + shipping,
  };
}

export function receivedQtyTotal(po: PurchaseOrderListItem | PurchaseOrderDetail): number {
  let total = 0;
  for (const grn of po.goodsReceipts ?? []) {
    for (const line of grn.items) total += line.receivedQty;
  }
  return total;
}

export function receivedPercent(po: PurchaseOrderListItem | PurchaseOrderDetail): number {
  const ordered = poLineCount(po.items);
  if (ordered <= 0) return po.status === "received" ? 100 : 0;

  const received = receivedQtyTotal(po);
  if (received <= 0) {
    // Status fallback when receipt rows are missing from the payload
    if (po.status === "received") return 100;
    return 0;
  }

  return Math.min(100, Math.round((received / ordered) * 100));
}

/** Received qty per product from all GRNs on a PO. */
export function receivedQtyByProduct(detail: PurchaseOrderDetail): Map<string, number> {
  const map = new Map<string, number>();
  for (const grn of detail.goodsReceipts ?? []) {
    for (const line of grn.items) {
      map.set(line.productId, (map.get(line.productId) ?? 0) + line.receivedQty);
    }
  }
  return map;
}

export function remainingQtyForProduct(
  detail: PurchaseOrderDetail,
  productId: string,
): number {
  const ordered = detail.items.find((i) => i.productId === productId)?.orderedQty ?? 0;
  const received = receivedQtyByProduct(detail).get(productId) ?? 0;
  return Math.max(0, ordered - received);
}

export function isPoOverdue(
  po: Pick<PurchaseOrderListItem, "expectedOn" | "status">,
): boolean {
  if (!po.expectedOn) return false;
  if (po.status !== "issued" && po.status !== "partially_received") return false;
  const expected = parseDateOnlyLocal(po.expectedOn);
  if (!expected) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expected.setHours(0, 0, 0, 0);
  return expected < today;
}

export function displayPoStatus(po: PurchaseOrderListItem): string {
  if (isPoOverdue(po)) return "overdue";
  return po.status;
}

/** Clerks may issue drafts only; pending_approval requires approve. */
export function canIssue(status: PoStatus): boolean {
  return status === "draft";
}

export function canApprove(status: PoStatus): boolean {
  return status === "pending_approval";
}

export function canReject(status: PoStatus): boolean {
  return status === "pending_approval";
}

export function canReceive(status: PoStatus): boolean {
  return status === "issued" || status === "partially_received";
}

export function canShortClose(status: PoStatus): boolean {
  return status === "partially_received";
}

export function canCancel(status: PoStatus): boolean {
  return status === "draft" || status === "pending_approval" || status === "issued";
}

/** Draft / pending can edit full PO header fields. */
export function canEditPo(status: PoStatus): boolean {
  return status === "draft" || status === "pending_approval";
}

/** Draft / pending / issued / partial can postpone or set expected delivery. */
export function canAdjustExpected(status: PoStatus): boolean {
  return (
    status === "draft" ||
    status === "pending_approval" ||
    status === "issued" ||
    status === "partially_received"
  );
}

export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function isInCurrentMonth(iso: string | null | undefined): boolean {
  return isDateInSummaryPeriod(iso, "this_month");
}
