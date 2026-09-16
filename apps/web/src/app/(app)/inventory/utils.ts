import type { MovementRow, QuarantineReasonCode, StockStatus } from "./types";

export function stockStatusLabel(status: StockStatus | null | undefined): string {
  if (status === "out") return "Out of stock";
  if (status === "low") return "Low stock";
  if (status === "ok") return "Healthy";
  return "—";
}

export function formatMoney(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (Number.isNaN(n)) return "—";
  return `LKR ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Short money figure for tight spaces: "LKR 14.5M". */
export function formatCompactMoney(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (Number.isNaN(n)) return "—";
  return `LKR ${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)}`;
}

/** Compact cost → sell line for batch tables. */
export function formatCostToSell(
  cost: string | number | null | undefined,
  sell: string | number | null | undefined,
): { cost: string; sell: string } {
  return { cost: formatMoney(cost), sell: formatMoney(sell) };
}

export function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function daysLabel(days: number): string {
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "1 day left";
  return `${days}d left`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const QUARANTINE_REASON_OPTIONS: { value: QuarantineReasonCode; label: string }[] = [
  { value: "damaged", label: "Damaged" },
  { value: "expired", label: "Expired" },
  { value: "recall", label: "Recall" },
  { value: "inspection", label: "Awaiting inspection" },
  { value: "other", label: "Other" },
];

export function quarantineReasonLabel(code: string | null | undefined): string | null {
  return QUARANTINE_REASON_OPTIONS.find((option) => option.value === code)?.label ?? null;
}

/** Where a movement's source document lives in the app, when it has a page to open. */
export function movementSourceHref(row: Pick<MovementRow, "referenceType" | "referenceId">): string | null {
  switch (row.referenceType) {
    case "transfer":
      return `/transfers?transfer=${row.referenceId}`;
    case "stocktake":
      return `/stocktakes/${row.referenceId}`;
    case "goods_return":
      return `/returns?return=${row.referenceId}`;
    default:
      return null;
  }
}

export function formatUnits(qty: number): string {
  return `${qty.toLocaleString()} ${Math.abs(qty) === 1 ? "unit" : "units"}`;
}
