import type { AuthUser } from "@/lib/auth-types";
import { formatDate, formatMoney } from "../purchasing/utils";
import { SCOPE_LABELS } from "./constants";
import {
  COMPLETE_ROLES,
  WRITE_ROLES,
  type StocktakeLine,
  type StocktakeLineFilter,
  type StocktakeListItem,
  type StocktakeStatus,
} from "./types";

export { formatDate, formatMoney };

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
  return scoped.some((br) => COMPLETE_ROLES.has(br.role));
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
  return status === "draft";
}

export function canEditCounts(status: StocktakeStatus): boolean {
  return status === "draft" || status === "in_progress";
}

export function canComplete(status: StocktakeStatus): boolean {
  return status === "draft" || status === "in_progress";
}

export function canCancel(status: StocktakeStatus): boolean {
  return status === "draft" || status === "in_progress";
}

export function matchesStatusFilter(
  row: StocktakeListItem,
  filter: string,
): boolean {
  if (filter === "all") return true;
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
  stocktake: Pick<StocktakeListItem, "blindCount" | "status">,
): boolean {
  if (!stocktake.blindCount) return true;
  return stocktake.status === "completed" || stocktake.status === "cancelled";
}

export function liveVariance(
  systemQty: number,
  countedRaw: string,
  savedVariance: number | null,
): number | null {
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
      case "uncounted": {
        const raw = opts?.counts?.[line.batchId];
        if (raw != null) return raw.trim() === "";
        return line.countedQty == null;
      }
      case "variance": {
        const raw = opts?.counts?.[line.batchId] ?? "";
        const v = liveVariance(line.systemQty, raw, line.varianceQty);
        return v != null && v !== 0;
      }
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
  let missingNotes = 0;

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

    const variance = qty - line.systemQty;
    if (variance !== 0) {
      const note = (notes[line.batchId] ?? line.note ?? "").trim();
      if (!note) missingNotes += 1;
    }
  }

  if (uncounted > 0) {
    blockers.push(`${uncounted} line${uncounted === 1 ? "" : "s"} still uncounted`);
  }
  if (missingNotes > 0) {
    blockers.push(
      `${missingNotes} variance line${missingNotes === 1 ? "" : "s"} missing a note`,
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
    ...(showSys ? ["System qty"] : []),
    "Counted qty",
    "Variance",
    "Note",
    "Cost price",
    "Variance value",
  ];

  const rows = detail.lines.map((line) => {
    const variance = line.varianceQty ?? (line.countedQty != null ? line.countedQty - line.systemQty : null);
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
      ...(showSys ? [String(line.systemQty)] : []),
      line.countedQty == null ? "" : String(line.countedQty),
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

export function formatSigned(n: number): string {
  if (n > 0) return `+${n}`;
  return String(n);
}
