/** Display helpers for product pages (LKR default for pharmacy pricing). */

import type { ProductDetailTab, StockStatus } from "../types";

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

export function formatMovementType(type: string): string {
  const labels: Record<string, string> = {
    purchase_in: "Goods received",
    sale_out: "POS sale",
    customer_return_in: "Customer return",
    supplier_return_out: "Supplier return",
    transfer_out: "Transfer out",
    transfer_in: "Transfer in",
    adjustment_in: "Adjustment in",
    adjustment_out: "Adjustment out",
    sale_void_in: "Sale void",
    sale_refund_in: "Sale refund",
  };
  if (labels[type]) return labels[type];
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatMovementDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatMovementReference(
  referenceType: string,
  referenceId: string,
  reason?: string | null,
): string {
  if (reason?.trim()) return reason.trim();
  const label = referenceType.replace(/_/g, " ");
  return `${label} · ${referenceId.slice(0, 8)}`;
}

export type HistoryFilter = "all" | "product" | "stock" | "pricing";

export type HistoryDatePreset = "all" | "7" | "30" | "90";

export function historyEventCategory(
  eventName: string,
  payload?: unknown,
): HistoryFilter {
  const name = eventName.toLowerCase();
  if (name.startsWith("stock.") || name === "inventory.adjustment") return "stock";
  if (
    name.includes("price") ||
    name.includes("pricing") ||
    (payload &&
      typeof payload === "object" &&
      ("price" in (payload as object) ||
        "sellingPrice" in (payload as object) ||
        "costPrice" in (payload as object)))
  ) {
    return "pricing";
  }
  if (
    name.includes("stock") ||
    name.includes("batch") ||
    name.includes("inventory") ||
    name.includes("adjustment") ||
    name.includes("transfer") ||
    name.includes("receipt")
  ) {
    return "stock";
  }
  if (name.includes("product")) return "product";
  return "product";
}

export type HistoryActivityTone = "primary" | "success" | "warning" | "danger" | "info";

export function historyActivityTone(eventName: string): HistoryActivityTone {
  const name = eventName.toLowerCase();
  if (name.includes("price") || name.includes("pricing")) return "success";
  if (name.includes("expir") || name.includes("alert")) return "danger";
  if (
    name.includes("stock") ||
    name.includes("adjustment") ||
    name.includes("batch")
  ) {
    return "warning";
  }
  if (name.includes("receipt") || name.includes("purchase")) return "success";
  if (name.includes("transfer")) return "info";
  return "primary";
}

export function formatHistoryReference(eventName: string, payload?: unknown): string {
  const category = historyEventCategory(eventName, payload);
  const labels: Record<HistoryFilter, string> = {
    all: "Product detail",
    product: "Product detail",
    stock: "Inventory",
    pricing: "Pricing",
  };
  const section =
    category === "product"
      ? "Overview"
      : category === "stock"
        ? "Stock & batches"
        : category === "pricing"
          ? "Pricing"
          : "Overview";
  return `${labels[category]} · ${section}`;
}

/** Maps a history event to the product detail tab that owns that activity. */
export function historyTargetTab(eventName: string, payload?: unknown): ProductDetailTab {
  const category = historyEventCategory(eventName, payload);
  if (category === "pricing") return "pricing";
  if (category === "stock") return "stock";
  return "overview";
}

export function historyActionLabel(eventName: string, payload?: unknown): string {
  const tab = historyTargetTab(eventName, payload);
  if (tab === "pricing") return "View pricing";
  if (tab === "stock") return "View stock";
  return "View overview";
}

export function formatHistorySummary(
  eventName: string,
  payload: unknown,
): string {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const name = eventName.toLowerCase();
    if (name.includes("price") && obj.from != null && obj.to != null) {
      return `Selling price changed from ${formatCurrency(obj.from as string | number)} to ${formatCurrency(obj.to as string | number)}`;
    }
    if (name.startsWith("stock.") || name === "inventory.adjustment") {
      const parts: string[] = [];
      if (obj.qty != null || obj.qtyDelta != null) {
        const qty = obj.qty ?? obj.qtyDelta;
        const n = Number(qty);
        parts.push(
          Number.isFinite(n)
            ? `${n >= 0 ? "+" : ""}${n} units`
            : `${String(qty)} units`,
        );
      }
      if (obj.batchNo) parts.push(`batch ${String(obj.batchNo)}`);
      if (obj.reason) parts.push(String(obj.reason));
      if (parts.length > 0) return parts.join(" · ");
    }
    if (obj.field && obj.from != null && obj.to != null) {
      return `${String(obj.field)} changed from ${String(obj.from)} to ${String(obj.to)}`;
    }
    if (obj.qty != null) {
      return `Quantity: ${String(obj.qty)} units`;
    }
    if (obj.grnNumber) {
      return `GRN ${String(obj.grnNumber)}`;
    }
    if (obj.status) {
      return `Status: ${String(obj.status)}`;
    }
  }
  return summarizeAuditPayload(payload) ?? formatAuditEventName(eventName);
}

export function stockStatusLabel(status: StockStatus | null | undefined): string {
  if (status === "out") return "Out of stock";
  if (status === "low") return "Low stock";
  if (status === "ok") return "Healthy";
  return "—";
}
