import type { StockBatch } from "../../shared/ipc-contract";

/** Mirrors `packages/shared/src/stock-quarantine.ts` — duplicated so renderer build does not rely on CJS re-exports. */
export const QUARANTINE_REASON_CODES = [
  "expired",
  "damaged",
  "recall",
  "inspection",
  "other",
] as const;

export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];

export const QUARANTINE_REASON_LABELS: Record<QuarantineReasonCode, string> = {
  expired: "Expired",
  damaged: "Damaged",
  recall: "Recall",
  inspection: "Awaiting inspection",
  other: "Other",
};

export type QuarantineSheetMode = "quarantine" | "release";

export type QuarantineForm = {
  qtyText: string;
  allQty: boolean;
  reasonCode: QuarantineReasonCode;
  reasonText: string;
};

export function buildQuarantineBody(
  batchId: string,
  form: QuarantineForm,
  batch: StockBatch,
): {
  batchId: string;
  qty: number | null;
  reasonCode: QuarantineReasonCode;
  reason: string | null;
} {
  return {
    batchId,
    qty: form.allQty ? null : parseQty(form.qtyText),
    reasonCode: form.reasonCode,
    reason:
      form.reasonCode === "other"
        ? form.reasonText.trim() || null
        : null,
  };
}

export function buildReleaseBody(
  batchId: string,
  form: Pick<QuarantineForm, "qtyText" | "allQty" | "reasonText">,
): { batchId: string; qty: number | null; reason: string | null } {
  const trimmed = form.reasonText.trim();
  return {
    batchId,
    qty: form.allQty ? null : parseQty(form.qtyText),
    reason: trimmed ? trimmed : null,
  };
}

function parseQty(text: string): number {
  return Number.parseInt(text, 10);
}

export function quarantinePrimaryEnabled(
  form: QuarantineForm,
  batch: StockBatch,
  online: boolean,
  hasPermission: boolean,
): boolean {
  if (!online || !hasPermission) return false;
  if (batch.available <= 0 && batch.onHand <= 0) return false;
  if (form.allQty) return form.reasonCode !== "other" || !!form.reasonText.trim();
  const q = parseQty(form.qtyText);
  if (!Number.isInteger(q) || q <= 0) return false;
  if (form.reasonCode === "other" && !form.reasonText.trim()) return false;
  return q <= batch.available;
}

export function releasePrimaryEnabled(
  form: Pick<QuarantineForm, "qtyText" | "allQty">,
  batch: StockBatch,
  online: boolean,
  hasPermission: boolean,
): boolean {
  if (!online || !hasPermission) return false;
  if (batch.expired) return false;
  if (batch.quarantined <= 0) return false;
  if (form.allQty) return true;
  const q = parseQty(form.qtyText);
  return Number.isInteger(q) && q > 0 && q <= batch.quarantined;
}

export type MappedStockCommandError =
  | { kind: "permission" }
  | { kind: "offline" }
  | { kind: "not_found" }
  | { kind: "validation"; message: string }
  | { kind: "available"; message: string }
  | { kind: "nothing_left"; message: string }
  | { kind: "nothing_held"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "server"; message: string }
  | { kind: "other"; message: string };

export function mapStockCommandError(
  code: string | undefined,
  message: string,
): MappedStockCommandError {
  const lower = message.toLowerCase();
  if (code === "PERMISSION_DENIED" || code === "FORBIDDEN")
    return { kind: "permission" };
  if (code === "NOT_ONLINE" || code === "ONLINE_REQUIRED")
    return { kind: "offline" };
  if (code === "NOT_FOUND" || lower.includes("batch not found"))
    return { kind: "not_found" };
  if (message === "Describe why the stock is being held")
    return { kind: "validation", message };
  if (message === "Nothing is quarantined on this batch")
    return { kind: "nothing_held", message };
  if (
    message.startsWith("Nothing left to quarantine") ||
    message.startsWith("There is no stock on this batch to quarantine")
  )
    return { kind: "nothing_left", message };
  if (message.startsWith("Only ") && message.includes(" available on "))
    return { kind: "available", message };
  if (message.startsWith("This batch expired on "))
    return { kind: "expired", message };
  if (code === "UNCERTAIN" || code === "NETWORK_ERROR")
    return { kind: "server", message };
  return { kind: "other", message };
}
