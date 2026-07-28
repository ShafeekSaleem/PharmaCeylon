import type { AuthUser } from "@/lib/auth-types";
import { formatDate, formatDateTime, formatMoney } from "../purchasing/utils";
import { SCOPE_LABELS } from "./constants";
import {
  REVIEW_ROLES,
  WRITE_ROLES,
  type StocktakeLine,
  type StocktakeLineFilter,
  type StocktakeListItem,
  type StocktakeMovementRef,
  type StocktakeStatus,
} from "./types";

export { formatDate, formatDateTime, formatMoney };

export function hasStocktakeWriteAccess(
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

export function canCompleteStocktake(
  user: AuthUser | null,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (user.branchRoles.some((br) => br.role === "owner")) return true;
  const scoped = branchId
    ? user.branchRoles.filter((br) => br.branchId === branchId)
    : user.branchRoles;
  return scoped.some((br) => REVIEW_ROLES.has(br.role));
}

export function formatStocktakeNo(row: Pick<StocktakeListItem, "stocktakeNumber">): string {
  return row.stocktakeNumber;
}

export function countedProgress(row: StocktakeListItem): number {
  if (typeof row.progressPct === "number") return row.progressPct;
  const total = row.lineCount ?? row.lines.length;
  if (total === 0) return 0;
  const counted =
    row.countedLineCount ?? row.lines.filter((l) => l.countedQty != null).length;
  return Math.min(100, Math.round((counted / total) * 100));
}

export function canStart(status: StocktakeStatus): boolean {
  return status === "draft" || status === "scheduled";
}

export function canEditCounts(status: StocktakeStatus): boolean {
  return status === "counting";
}

/** Matches API HEADER_EDITABLE_STATUSES */
export function canEditHeader(status: StocktakeStatus): boolean {
  return (
    status === "draft" ||
    status === "scheduled" ||
    status === "counting" ||
    status === "submitted"
  );
}

/** Matches API PRE_REVIEW_STATUSES — add/remove lines */
export function canManageLines(status: StocktakeStatus): boolean {
  return status === "draft" || status === "scheduled" || status === "counting";
}

export function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function datetimeLocalToIsoOrNull(localValue: string): string | null {
  const trimmed = localValue.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function canComplete(status: StocktakeStatus): boolean {
  return status === "posted";
}

export function canCancel(status: StocktakeStatus): boolean {
  return (
    status === "draft" ||
    status === "scheduled" ||
    status === "counting" ||
    status === "submitted" ||
    status === "under_review"
  );
}

export function canSubmit(status: StocktakeStatus): boolean {
  return status === "counting";
}

export function canStartReview(status: StocktakeStatus): boolean {
  return status === "submitted";
}

export function canApprove(status: StocktakeStatus): boolean {
  return status === "under_review";
}

export function canPost(status: StocktakeStatus): boolean {
  return status === "approved";
}

export function matchesStatusFilter(
  row: StocktakeListItem,
  filter: string,
): boolean {
  if (filter === "all") return true;
  if (filter === "active") {
    return ["scheduled", "counting", "submitted", "under_review", "approved"].includes(row.status);
  }
  if (filter === "attention") {
    return (
      row.status === "submitted" ||
      row.status === "under_review" ||
      row.status === "approved" ||
      (row.status === "counting" && row.uncountedLineCount > 0)
    );
  }
  return row.status === filter;
}

/** Days until expiry (calendar); negative if already expired. */
export function daysUntilExpiry(expiryIso: string, now = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiryIso.trim());
  const expiry = m
    ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    : new Date(expiryIso);
  if (Number.isNaN(expiry.getTime())) return Number.POSITIVE_INFINITY;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.ceil((expiry.getTime() - today.getTime()) / 86_400_000);
}

export function isNearExpiry(
  expiryIso: string,
  withinDays: number = 90,
  now = new Date(),
): boolean {
  const days = daysUntilExpiry(expiryIso, now);
  return days <= withinDays;
}

export function showSystemQty(
  stocktake: Pick<StocktakeListItem, "blindCount" | "status" | "permissions">,
): boolean {
  if (!stocktake.blindCount) return true;
  if (
    stocktake.status === "posted" ||
    stocktake.status === "completed" ||
    stocktake.status === "cancelled"
  ) {
    return true;
  }
  // Blind counts stay hidden through counting/submitted so counters (incl. supervisors
  // who help count) cannot see expected qty. Reviewers unlock once review starts.
  if (stocktake.permissions.canViewExpected) {
    return stocktake.status === "under_review" || stocktake.status === "approved";
  }
  return false;
}

export function liveVariance(
  systemQty: number | null,
  countedRaw: string,
  savedVariance: number | null,
): number | null {
  if (systemQty == null) return null;
  const raw = countedRaw.trim();
  if (raw === "") return savedVariance;
  const qty = Number(raw);
  if (!Number.isInteger(qty) || qty < 0) return null;
  return qty - systemQty;
}

export function filterStocktakeLines(
  lines: StocktakeLine[],
  filter: StocktakeLineFilter,
  opts?: {
    counts?: Record<string, string>;
    nearExpiryDays?: number;
  },
): StocktakeLine[] {
  const nearDays = opts?.nearExpiryDays ?? 90;
  return lines.filter((line) => {
    switch (filter) {
      case "pending": {
        const raw = opts?.counts?.[line.batchId];
        if (raw != null) return raw.trim() === "";
        return line.countedQty == null;
      }
      case "counted":
        return line.countedQty != null;
      case "variance": {
        if (line.expectedAtReview == null) return false;
        const raw = opts?.counts?.[line.batchId] ?? "";
        const v = liveVariance(line.expectedAtReview, raw, line.adjustedVariance);
        return v != null && v !== 0;
      }
      case "recount":
        return line.countStatus === "recount_requested" || line.countEntries.some((entry) => entry.isRecount);
      case "quarantined":
        return line.batch.isQuarantined;
      case "near_expiry":
        return isNearExpiry(line.batch.expiryDate, nearDays);
      case "all":
      default:
        return true;
    }
  });
}

export function completeBlockers(
  detail: StocktakeListItem,
  counts: Record<string, string>,
  notes: Record<string, string>,
): string[] {
  const blockers: string[] = [];
  let uncounted = 0;

  for (const line of detail.lines) {
    const raw = (counts[line.batchId] ?? "").trim();
    const qty =
      raw === ""
        ? line.countedQty
        : Number.isInteger(Number(raw)) && Number(raw) >= 0
          ? Number(raw)
          : null;

    if (qty == null) {
      uncounted += 1;
      continue;
    }
  }

  if (uncounted > 0) {
    blockers.push(`${uncounted} line${uncounted === 1 ? "" : "s"} still uncounted`);
  }
  return blockers;
}

/** True when a variance line has both reason and resolution (draft or saved). */
export function lineHasCompleteReview(
  line: Pick<StocktakeLine, "reviewReason" | "reviewResolution">,
  draft?: {
    reviewReason?: string | null;
    reviewResolution?: string | null;
  },
): boolean {
  const reason = draft?.reviewReason || line.reviewReason;
  const resolution = (draft?.reviewResolution || line.reviewResolution || "").trim();
  return Boolean(reason && resolution);
}

/** Non-zero variance lines still missing reason + resolution (draft or saved). */
export function reviewApprovalBlockers(
  detail: StocktakeListItem,
  drafts: Record<
    string,
    {
      reviewReason?: string | null;
      reviewResolution?: string | null;
      selectedForRecount?: boolean;
    }
  >,
): string[] {
  const blockers: string[] = [];
  let missing = 0;
  let recountPending = 0;

  for (const line of detail.lines) {
    const variance = line.adjustedVariance;
    const draft = drafts[line.id];
    if (line.countStatus === "recount_requested" || draft?.selectedForRecount) {
      recountPending += 1;
      continue;
    }
    if (variance == null || variance === 0) continue;
    if (!lineHasCompleteReview(line, draft)) missing += 1;
  }

  if (missing > 0) {
    blockers.push(
      `${missing} variance line${missing === 1 ? "" : "s"} need a reason and resolution before approve`,
    );
  }
  if (recountPending > 0) {
    blockers.push(
      `${recountPending} line${recountPending === 1 ? "" : "s"} still marked for recount`,
    );
  }
  return blockers;
}

export function exportStocktakeCsv(detail: StocktakeListItem): void {
  const showSys = showSystemQty(detail);
  const headers = [
    "SKU",
    "Product",
    "Batch",
    "Expiry",
    "Quarantined",
    ...(showSys ? ["Snapshot qty", "Movement delta", "Expected at review"] : []),
    "Counted qty",
    "Condition",
    "Variance",
    "Note",
    "Cost price",
    "Variance value",
  ];

  const rows = detail.lines.map((line) => {
    const variance =
      line.adjustedVariance ??
      (line.countedQty != null && line.expectedAtReview != null
        ? line.countedQty - line.expectedAtReview
        : null);
    const value =
      variance != null && Number.isFinite(line.batch.costPrice)
        ? Math.round(variance * line.batch.costPrice * 100) / 100
        : "";
    return [
      line.product.sku,
      line.product.name,
      line.batch.batchNo,
      formatDate(line.batch.expiryDate),
      line.batch.isQuarantined ? "yes" : "no",
      ...(showSys
        ? [
            String(line.snapshotQty ?? ""),
            String(line.movementDeltaSinceSnapshot ?? ""),
            String(line.expectedAtReview ?? ""),
          ]
        : []),
      line.countedQty == null ? "" : String(line.countedQty),
      displayCondition(line.condition),
      variance == null ? "" : String(variance),
      line.note ?? "",
      String(line.batch.costPrice),
      value === "" ? "" : String(value),
    ];
  });

  const escape = (cell: string) => {
    if (/[",\n\r]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
    return cell;
  };

  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${detail.stocktakeNumber}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function scopeLabel(scope: StocktakeListItem["scope"] | undefined): string {
  if (!scope) return SCOPE_LABELS.full;
  return SCOPE_LABELS[scope] ?? scope;
}

export function statusLabel(status: StocktakeStatus): string {
  switch (status) {
    case "under_review":
      return "Under review";
    case "draft":
      return "Draft";
    case "scheduled":
      return "Scheduled";
    case "counting":
      return "In progress";
    case "submitted":
      return "Submitted";
    case "approved":
      return "Approved";
    case "posted":
      return "Posted";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

export function movementModeLabel(mode: StocktakeListItem["movementMode"]): string {
  switch (mode) {
    case "freeze_transactions":
      return "Freeze transactions";
    case "continue_and_reconcile":
    default:
      return "Continue & reconcile";
  }
}

export function displayCondition(condition: StocktakeLine["condition"]): string {
  return condition.replace(/_/g, " ");
}

export function displayVarianceReason(reason: string | null | undefined): string {
  if (!reason) return "—";
  return reason.replace(/_/g, " ");
}

export function formatSigned(n: number): string {
  if (n > 0) return `+${n}`;
  return String(n);
}

export function awaitingMyAction(row: StocktakeListItem, userId?: string | null): boolean {
  if (!userId) return false;
  if (row.status === "counting") {
    return row.assignments.some((assignment) => assignment.user.id === userId);
  }
  if (row.status === "submitted" || row.status === "under_review" || row.status === "approved") {
    return row.reviewer?.id === userId || row.approver?.id === userId || row.counter.id === userId;
  }
  return false;
}

export function stocktakeHref(id: string): string {
  return `/stocktakes/${id}`;
}

export function movementHref(ref: StocktakeMovementRef): string | null {
  switch (ref.referenceType) {
    case "stocktake":
      return `/stocktakes/${ref.referenceId}`;
    case "adjustment":
      return `/inventory/adjustments`;
    case "purchase":
    case "goods_receipt":
      return `/purchasing`;
    case "customer_return":
    case "supplier_return":
      return `/returns`;
    case "transfer":
      return `/transfers`;
    case "sale":
      return `/pos`;
    default:
      return null;
  }
}
