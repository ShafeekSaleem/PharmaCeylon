import type { ReactElement } from "react";
import {
  IconBox,
  IconClipboard,
  IconClipboardList,
  IconDollarSign,
  IconLock,
  IconPackage,
  IconRefresh,
  IconTruck,
  IconUsers,
  type IconProps,
} from "@/components/icons";
import type { AuditDateRangeFilter, AuditEventRow } from "./types";

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const EVENT_LABEL_OVERRIDES: Record<string, string> = {
  "auth.login_failed": "Login failed",
  "sale.posted": "Sale completed",
  "sale.voided": "Sale voided",
  "sale.refunded": "Sale refunded",
  "sale.pharmacist_approved": "Pharmacist approval recorded",
  "sale.pharmacist_pin_failed": "Pharmacist PIN entry failed",
  "role.permissions_updated": "Role permissions changed",
  "user.sessions.force_logout": "All sessions force-logged-out",
  "user.branch_role.assigned": "Branch role assigned",
  "user.branch_role.removed": "Branch role removed",
  "user.pos_pin.set": "POS PIN set",
  "user.pos_pin.cleared": "POS PIN cleared",
  "user.pos_pin.admin_reset": "POS PIN reset by admin",
  "products.nmra_import": "NMRA catalog import",
  "products.barcode_import": "Barcode import",
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function formatAuditEventLabel(eventName: string): string {
  const override = EVENT_LABEL_OVERRIDES[eventName];
  if (override) return override;
  const words = eventName.replace(/[._]/g, " ").split(" ").filter(Boolean);
  return words.map((word, i) => (i === 0 ? capitalize(word) : word)).join(" ");
}

const ENTITY_LABELS: Record<string, string> = {
  product: "Product",
  batch: "Batch",
  purchase_order: "Purchase Order",
  goods_receipt: "Goods Receipt",
  goods_return: "Return",
  supplier: "Supplier",
  supplier_invoice: "Supplier Invoice",
  stocktake: "Stocktake",
  app_user: "User",
  user_branch_role: "Branch Role",
  sale: "Sale",
  transfer: "Transfer",
  role: "Role",
  stock_ledger: "Stock Ledger",
};

export function auditEntityLabel(entityName: string): string {
  return ENTITY_LABELS[entityName] ?? entityName.replace(/_/g, " ");
}

/** Only entities with a known deep-link target render as a link; others render as plain text. */
export function auditEntityHref(entityName: string, entityId: string): string | null {
  switch (entityName) {
    case "product":
      return `/products/${entityId}`;
    case "purchase_order":
      return `/purchasing?po=${entityId}`;
    case "transfer":
      return `/transfers?transfer=${entityId}`;
    case "goods_return":
      return `/returns?return=${entityId}`;
    case "supplier":
      return `/suppliers?supplier=${entityId}`;
    default:
      return null;
  }
}

export type AuditTone = "teal" | "blue" | "amber" | "red";

const BLUE_PREFIXES = new Set(["inventory", "batch", "stocktake", "transfer", "stock_adjustment"]);
const AMBER_PREFIXES = new Set([
  "purchase_order",
  "goods_receipt",
  "supplier",
  "supplier_invoice",
  "return",
  "sale",
]);

export function auditEventTone(eventName: string, critical: boolean): AuditTone {
  if (critical) return "red";
  const prefix = eventName.split(".")[0];
  if (BLUE_PREFIXES.has(prefix)) return "blue";
  if (AMBER_PREFIXES.has(prefix)) return "amber";
  return "teal";
}

const PREFIX_ICONS: Record<string, (props: IconProps) => ReactElement> = {
  product: IconPackage,
  products: IconPackage,
  batch: IconBox,
  inventory: IconBox,
  stock_adjustment: IconBox,
  stocktake: IconClipboard,
  transfer: IconTruck,
  purchase_order: IconClipboardList,
  goods_receipt: IconClipboardList,
  supplier: IconUsers,
  supplier_invoice: IconClipboardList,
  return: IconRefresh,
  sale: IconDollarSign,
  user: IconUsers,
  role: IconUsers,
  auth: IconLock,
};

export function auditEventIcon(eventName: string): (props: IconProps) => ReactElement {
  const prefix = eventName.split(".")[0];
  return PREFIX_ICONS[prefix] ?? IconClipboard;
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return null;
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return capitalize(spaced.toLowerCase());
}

/** Turns an event's raw JSON payload into a short, human-readable summary for the Details column. */
export function summarizeAuditPayload(eventName: string, rawPayload: unknown): string | null {
  const payload = asRecord(rawPayload);
  if (!payload) return null;

  switch (eventName) {
    case "auth.login_failed": {
      const attempts = payload.attempts;
      return payload.locked
        ? `Account locked after ${attempts} failed attempt${attempts === 1 ? "" : "s"}`
        : `Failed attempt${attempts != null ? ` #${attempts}` : ""}`;
    }
    // Sale/PO/GRN/transfer reference numbers are already shown in the Entity column
    // (via the server-resolved entityLabel) — Details surfaces whatever else is useful
    // instead of repeating that same number.
    case "sale.voided":
      return payload.reason ? `Reason: ${payload.reason}` : "No reason given";
    case "sale.posted":
    case "sale.refunded":
      return payload.grandTotal ? `Total Rs. ${payload.grandTotal}` : null;
    case "purchase_order.created":
    case "purchase_order.updated":
      return payload.status ? `Status: ${String(payload.status).replace(/_/g, " ")}` : null;
    case "role.permissions_updated": {
      const added = Array.isArray(payload.added) ? payload.added.length : 0;
      const removed = Array.isArray(payload.removed) ? payload.removed.length : 0;
      const parts = [added > 0 ? `+${added} granted` : null, removed > 0 ? `−${removed} revoked` : null].filter(
        Boolean,
      );
      return parts.length > 0 ? parts.join(", ") : "No changes";
    }
    case "product.updated":
      return payload.field
        ? `${humanizeKey(String(payload.field))} changed from ${payload.from} to ${payload.to}`
        : null;
    case "transfer.created":
    case "transfer.created_and_approved":
      return payload.status ? `Status: ${String(payload.status).replace(/_/g, " ")}` : null;
    case "inventory.adjustment":
    case "stock_adjustment.posted": {
      const qty = payload.qty;
      const movement = payload.movementType ? String(payload.movementType).replace(/_/g, " ") : "Adjustment";
      return typeof qty === "number" ? `${capitalize(movement)}: ${Math.abs(qty)} units` : capitalize(movement);
    }
    default:
      break;
  }

  return genericPayloadSummary(payload);
}

const REDUNDANT_REFERENCE_KEYS = new Set([
  "poNumber",
  "invoiceNo",
  "invoiceNumber",
  "grnNumber",
  "transferNumber",
  "stocktakeNumber",
  "returnNumber",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Renders up to 3 primitive fields as "Key: value" for events with no dedicated case above.
 * Skips reference numbers already shown via the Entity column's resolved label, and skips
 * any raw-UUID-shaped value regardless of its key name — those are internal ids a viewer
 * can't act on, not something worth surfacing.
 */
function genericPayloadSummary(payload: Record<string, unknown>): string | null {
  const entries = Object.entries(payload)
    .filter(([key, value]) => {
      if (value === null || value === undefined || value === "") return false;
      if (REDUNDANT_REFERENCE_KEYS.has(key)) return false;
      if (/(^id$|Id$)/.test(key)) return false;
      if (typeof value === "string" && UUID_PATTERN.test(value)) return false;
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    })
    .slice(0, 3)
    .map(([key, value]) => `${humanizeKey(key)}: ${value}`);

  return entries.length > 0 ? entries.join(" · ") : null;
}

export function dateRangeToIso(range: AuditDateRangeFilter): { from?: string; to?: string } {
  if (range === "all") return {};
  if (range === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString() };
  }
  const days = Number(range);
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString() };
}

function csvEscape(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportAuditEventsCsv(rows: AuditEventRow[]) {
  const headers = ["Date & time", "Event", "Entity", "Entity ID", "Actor", "Branch", "Critical", "Details"];
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [
        formatDateTime(r.createdAt),
        formatAuditEventLabel(r.eventName),
        auditEntityLabel(r.entityName),
        r.entityId,
        r.actor?.fullName ?? "System",
        r.branch?.name ?? "",
        r.critical ? "Yes" : "No",
        summarizeAuditPayload(r.eventName, r.payload) ?? "",
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
