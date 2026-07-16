/** Display helpers for product pages (LKR default for pharmacy pricing). */

const CURRENCY = "LKR";

export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat("en-LK", {
    style: "currency",
    currency: CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatCurrencyRange(
  min: string | null | undefined,
  max: string | null | undefined,
): string {
  if (!min && !max) return "—";
  if (min && max && min !== max) return `${formatCurrency(min)} – ${formatCurrency(max)}`;
  return formatCurrency(min ?? max);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeExpiry(expiryDate: string): {
  label: string;
  tone: "ok" | "warn" | "danger";
} {
  const expiry = new Date(expiryDate);
  const now = new Date();
  const days = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: "Expired", tone: "danger" };
  if (days <= 30) return { label: `${days}d left`, tone: "warn" };
  if (days <= 90) return { label: `${days}d left`, tone: "ok" };
  return { label: formatDate(expiryDate), tone: "ok" };
}

export function formatAuditEventName(name: string): string {
  return name
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function summarizeAuditPayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return String(payload);
  try {
    const obj = payload as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return null;
    const parts = keys.slice(0, 4).map((k) => {
      const v = obj[k];
      if (v === null || v === undefined) return `${k}: —`;
      if (typeof v === "object") return `${k}: …`;
      return `${k}: ${String(v)}`;
    });
    if (keys.length > 4) parts.push(`+${keys.length - 4} more`);
    return parts.join(" · ");
  } catch {
    return null;
  }
}

export function computeMarginPercent(
  selling: string | number,
  cost: string | number,
): number | null {
  const sell = Number(selling);
  const c = Number(cost);
  if (Number.isNaN(sell) || Number.isNaN(c) || sell <= 0) return null;
  return Math.round(((sell - c) / sell) * 100);
}
