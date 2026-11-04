import type {
  ProductStock,
  StockBatch,
  StockRow,
} from "../../shared/ipc-contract";
import { minor, money } from "./sell-model";

/**
 * The batch checkout sells next, or null when nothing here can be sold.
 *
 * This is the rule `sales.service.ts` checkout uses to pick a batch when the line names none
 * (FEFO): batches that are not wholly quarantined, have a confirmed expiry and are in date (by
 * the tenant's business date, which the server has already applied to `expired`), earliest
 * expiry first, and the first one with stock it can sell. Checkout takes the first batch with
 * enough for the whole line, so a line larger than this batch's available units can come from
 * a later one; for a single unit it is always this one.
 */
export function sellFirstBatch(batches: readonly StockBatch[]): StockBatch | null {
  const candidates = batches
    .filter((b) => !b.isQuarantined && !b.needsExpiryReview && !b.expired)
    // Stable: equal dates keep the server's order, as checkout's query does.
    .map((b, index) => ({ b, index }))
    .sort(
      (x, y) =>
        x.b.expiryDate.localeCompare(y.b.expiryDate) || x.index - y.index,
    )
    .map(({ b }) => b);
  return candidates.find((b) => b.available > 0) ?? null;
}

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";
export type BatchAction = "write-off" | "quarantine" | "adjust" | null;

export type BatchStatus = { label: string; tone: Tone; action: BatchAction };

/** What a batch row says, and the one action it offers, as the mockup draws them. */
export function batchStatus(batch: StockBatch, sellFirst: boolean): BatchStatus {
  const held = batch.quarantined > 0;
  if (held && batch.expired)
    return { label: "Quarantined · expired", tone: "warn", action: "write-off" };
  if (batch.isQuarantined)
    return { label: "Quarantined", tone: "warn", action: "write-off" };
  if (batch.expired)
    return { label: "Expired · not for sale", tone: "bad", action: "quarantine" };
  if (batch.needsExpiryReview)
    return { label: "Check expiry date", tone: "warn", action: "quarantine" };
  // Checkout sells the earliest in-date batch first, expiring or not, so the label says so even
  // where the mockup shows an expiring batch skipped.
  if (sellFirst && batch.nearExpiry)
    return { label: "Sell first · expiring", tone: "bad", action: "quarantine" };
  if (batch.nearExpiry)
    return { label: "Expiring · sell or hold", tone: "bad", action: "quarantine" };
  if (sellFirst) return { label: "Sell first", tone: "info", action: "adjust" };
  if (held)
    return { label: `${batch.quarantined} held`, tone: "warn", action: "adjust" };
  if (batch.available <= 0)
    return { label: "Promised", tone: "neutral", action: "adjust" };
  return { label: "Good", tone: "ok", action: "adjust" };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const ymd = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};

/** "Aug 2026"; with `day`, "24 Nov 2026". */
export function expiryLabel(iso: string, day = false) {
  const { y, m, d } = ymd(iso);
  return day ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${y}`;
}

/** "06/2027", as the result list writes a nearest expiry. */
export function expiryShort(iso: string) {
  const { y, m } = ymd(iso);
  return `${String(m).padStart(2, "0")}/${y}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "In 23 days", "In 3 months", "Expired 3 months ago", "Expires today". */
export function expiryWhen(daysToExpiry: number) {
  const days = Math.abs(daysToExpiry);
  const span =
    days < 60 ? plural(days, "day") : plural(Math.round(days / 30.44), "month");
  if (daysToExpiry === 0) return "Expires today";
  return daysToExpiry < 0 ? `Expired ${span} ago` : `In ${span}`;
}

/** "tabs" for "tab", "bottles" for "bottle"; "units" when the product names none. */
export function unitWord(unit: string | null, count = 2) {
  const word = unit?.trim() || "unit";
  return count === 1 || word.endsWith("s") ? word : `${word}s`;
}

export function productName(p: { name: string; strength: string | null }) {
  return p.strength && !p.name.includes(p.strength)
    ? `${p.name} ${p.strength}`
    : p.name;
}

/** "GSK · pack of 14" — who makes it and how it's packed. */
export function packText(p: {
  manufacturer: string | null;
  unitsPerPack: number;
  packLabel: string | null;
}) {
  const pack = p.packLabel?.trim()
    ? p.packLabel.trim()
    : p.unitsPerPack > 1
      ? `pack of ${p.unitsPerPack}`
      : null;
  return [p.manufacturer?.trim() || null, pack].filter(Boolean).join(" · ");
}

/** The result list's second line on the right: the most urgent thing about the product. */
export function rowNote(row: StockRow): { text: string; tone: Tone } {
  if (row.expiredBatchCount > 0)
    return { text: "Expired batch on the shelf", tone: "bad" };
  if (row.quarantined > 0 && row.available === 0)
    return { text: "All stock held", tone: "bad" };
  if (row.stockStatus === "out") return { text: "Out of stock", tone: "neutral" };
  if (row.stockStatus === "low")
    return { text: `Below reorder (${row.reorderLevel})`, tone: "warn" };
  if (row.quarantined > 0) return { text: `${row.quarantined} held`, tone: "warn" };
  if (row.nearExpiryBatchCount > 0)
    return { text: "Expiring soon", tone: "warn" };
  if (row.nextExpiry) return { text: `Exp ${expiryShort(row.nextExpiry)}`, tone: "neutral" };
  return { text: "", tone: "neutral" };
}

const MOVEMENTS: Record<string, string> = {
  purchase_in: "Received",
  sale_out: "Sold",
  customer_return_in: "Returned by customer",
  supplier_return_out: "Returned to supplier",
  transfer_out: "Sent to a branch",
  transfer_in: "Received from a branch",
  adjustment_in: "Added",
  adjustment_out: "Written off",
  opening_stock: "Opening stock",
  sale_void_in: "Sale voided",
  sale_refund_in: "Refunded",
  quarantine_hold: "Quarantined",
  quarantine_release: "Released",
  stocktake_in: "Found in count",
  stocktake_out: "Short in count",
};

export type Movement = ProductStock["movements"][number];

/** One recent movement: what happened and to which batch, and its quantity's tone. */
export function movementLine(m: Movement) {
  const what = MOVEMENTS[m.movementType] ?? m.movementType.replace(/_/g, " ");
  const quarantine = m.quarantineDelta !== 0;
  const qty = quarantine ? m.quarantineDelta : m.qtyDelta;
  return {
    what,
    batchNo: m.batchNo,
    who: m.actorName,
    qty: quarantine ? String(Math.abs(qty)) : qty > 0 ? `+${qty}` : `−${Math.abs(qty)}`,
    tone: quarantine ? ("hold" as const) : qty > 0 ? ("in" as const) : ("out" as const),
  };
}

/** "Today 14:05" or "31 Oct", in the counter's own time. */
export function movementWhen(iso: string, now: Date) {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay)
    return `Today ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/** A write-off's value at cost and whether it is under the limit, when both are known. */
export function writeOffCheck(
  batch: StockBatch,
  qty: number,
  limit: string | null,
): { valueMinor: number | null; limitMinor: number | null; overLimit: boolean | null } {
  const valueMinor = batch.costPrice === null ? null : minor(batch.costPrice) * qty;
  const limitMinor = limit === null ? null : minor(limit);
  return {
    valueMinor,
    limitMinor,
    // The server's rule: value at cost ≥ the threshold needs approval.
    // No limit: never over. Cost withheld (no costs.view): not known here; the server decides.
    overLimit:
      limitMinor === null
        ? false
        : valueMinor === null
          ? null
          : valueMinor >= limitMinor,
  };
}

export const rs = (valueMinor: number) => `Rs ${money(valueMinor)}`;
