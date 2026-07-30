import { CURRENCY } from "./constants";
import type { CartLine, PosBatch, PosProduct, ResolvedCartLine } from "./types";

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatMoney(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return `${CURRENCY} 0.00`;
  return `${CURRENCY} ${n.toLocaleString("en-LK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatAmount(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-LK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** First-expiry-first-out: soonest expiry that can still cover `qty`. */
export function pickFefoBatch(product: PosProduct, qty = 1): PosBatch | null {
  const withStock = product.batches.filter((b) => b.qtyOnHand >= qty);
  return withStock[0] ?? product.batches[0] ?? null;
}

export function productSubtitle(product: PosProduct): string {
  return (
    [product.genericName, product.strength, product.dosageForm]
      .filter(Boolean)
      .join(" · ") || product.sku
  );
}

/** Ranked substring match across the fields a cashier is likely to type. */
export function matchesQuery(product: PosProduct, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const barcode = product.barcode?.toLowerCase() ?? "";
  const sku = product.sku.toLowerCase();
  if (barcode === q) return 100;
  if (sku === q) return 95;

  const name = product.name.toLowerCase();
  if (name === q) return 90;
  if (name.startsWith(q)) return 70;

  const generic = product.genericName?.toLowerCase() ?? "";
  const brand = product.brandName?.toLowerCase() ?? "";
  if (generic.startsWith(q) || brand.startsWith(q)) return 60;
  if (name.includes(q)) return 45;
  if (generic.includes(q) || brand.includes(q)) return 35;
  if (sku.includes(q) || barcode.includes(q)) return 25;
  return 0;
}

/** An exact scan hit — barcode or SKU typed in full by the scanner wedge. */
export function findExactScan(products: PosProduct[], raw: string): PosProduct | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  return (
    products.find((p) => (p.barcode ?? "").toLowerCase() === q) ??
    products.find((p) => p.sku.toLowerCase() === q) ??
    null
  );
}

export function resolveLine(
  line: CartLine,
  product: PosProduct,
  batch: PosBatch,
  vatRatePercent: number,
): ResolvedCartLine {
  const gross = round2(line.unitPrice * line.qty);
  const discountAmount = round2((gross * line.discountPercent) / 100);
  const taxable = Math.max(gross - discountAmount, 0);
  const taxAmount = vatRatePercent > 0 ? round2((taxable * vatRatePercent) / 100) : 0;
  return {
    ...line,
    product,
    batch,
    gross,
    discountAmount,
    taxAmount,
    lineTotal: round2(taxable + taxAmount),
    overStock: line.qty > batch.qtyOnHand,
  };
}

export function makeLineKey(productId: string, batchId: string): string {
  return `${productId}:${batchId}`;
}

/**
 * Offline-safe idempotency key so a retried "Complete sale" (flaky counter Wi-Fi)
 * replays the original invoice instead of double-charging.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
