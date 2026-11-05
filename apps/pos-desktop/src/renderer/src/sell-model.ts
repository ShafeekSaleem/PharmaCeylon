/*
 * What Sell works out for itself: which products a search finds, how money is written, the cash
 * amounts offered as one-touch tenders, and what each SLMC refusal tells the counter to do. Kept
 * free of React and the DOM so it can be tested on its own (sell-model.spec.ts).
 */
import type { CatalogProduct } from "../../shared/ipc-contract";

/** The find panel's filter chips. */
export type FindFilter = "all" | "stock" | "rx" | "otc";

export const FIND_FILTERS: { id: FindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "stock", label: "In stock" },
  { id: "rx", label: "Prescription" },
  { id: "otc", label: "OTC" },
];

/** Search results are capped so a one-letter search stays quick to read. */
export const MAX_RESULTS = 20;

/** At or below this many units a result says "6 left" instead of "6 in stock". */
export const LOW_STOCK = 10;

export const minor = (amount: string) => Math.round(Number(amount) * 100);

const grouped = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 271850 → "2,718.50", the way the mockups write money. */
export const money = (valueMinor: number) => grouped.format(valueMinor / 100);

/** A cash amount for the cash field: 300000 → "3000.00", which moneyInput accepts. */
export const plainMoney = (valueMinor: number) => (valueMinor / 100).toFixed(2);

/** Name, exact SKU or exact barcode, as the counter has always searched. */
export function matches(product: CatalogProduct, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return (
    product.name.toLowerCase().includes(q) ||
    (product.sku ?? "").toLowerCase() === q ||
    (product.barcode ?? "") === query.trim()
  );
}

export function passesFilter(product: CatalogProduct, filter: FindFilter) {
  switch (filter) {
    case "stock":
      return product.available > 0;
    case "rx":
      return product.needsPharmacist;
    case "otc":
      return !product.needsPharmacist;
    default:
      return true;
  }
}

export function findProducts(
  catalog: CatalogProduct[],
  query: string,
  filter: FindFilter,
) {
  return catalog
    .filter((p) => matches(p, query) && passesFilter(p, filter))
    .slice(0, MAX_RESULTS);
}

/** A scanner types the barcode and Enter: the exact match, whatever the filter shows. */
export function scannedProduct(catalog: CatalogProduct[], query: string) {
  const code = query.trim();
  if (!code) return undefined;
  return catalog.find((p) => p.barcode && p.barcode === code);
}

/** Splits a name around the first place the search appears, for the highlight. */
export function highlight(name: string, query: string) {
  const q = query.trim().toLowerCase();
  const at = q ? name.toLowerCase().indexOf(q) : -1;
  if (at < 0) return { before: name, hit: "", after: "" };
  return {
    before: name.slice(0, at),
    hit: name.slice(at, at + q.length),
    after: name.slice(at + q.length),
  };
}

export function stockText(available: number) {
  if (available <= 0) return { text: "Out of stock", tone: "none" as const };
  if (available <= LOW_STOCK)
    return { text: `${available} left`, tone: "warn" as const };
  return { text: `${available} in stock`, tone: "ok" as const };
}

/** The next result to highlight when moving up or down, wrapping at either end. */
export function moveSelection(index: number, delta: number, count: number) {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * The cash a customer is likely to hand over: the next round hundred, five hundred, thousand and
 * five thousand above the total, three of them at most. Rs 2,718.50 → 2,800, 3,000 and 5,000.
 */
export function quickTenders(totalMinor: number): number[] {
  if (totalMinor <= 0) return [];
  const amounts: number[] = [];
  for (const step of [100_00, 500_00, 1000_00, 5000_00]) {
    const next = Math.ceil(totalMinor / step) * step;
    const above = next > totalMinor ? next : next + step;
    if (!amounts.includes(above)) amounts.push(above);
  }
  return amounts.sort((a, b) => a - b).slice(0, 3);
}

/** "Issued today", "Issued yesterday", "Issued 2 days ago" — both dates as YYYY-MM-DD. */
export function issuedAgo(issuedOn: string, today: string) {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${issuedOn}T00:00:00Z`)) /
      86_400_000,
  );
  if (!Number.isFinite(days) || days <= 0) return "Issued today";
  if (days === 1) return "Issued yesterday";
  return `Issued ${days} days ago`;
}

/** Checkout and the signed prescription command refuse with these when SLMC registration is missing. */
export const SLMC_REFUSALS = [
  "SELLER_NOT_QUALIFIED",
  "APPROVER_NOT_QUALIFIED",
  "PHARMACIST_REQUIRED",
] as const;
export type SlmcRefusalCode = (typeof SLMC_REFUSALS)[number];

export const isSlmcRefusal = (code: string): code is SlmcRefusalCode =>
  (SLMC_REFUSALS as readonly string[]).includes(code);

/** What the counter can do about the refusal. */
export type RefusalAction = "choose-pharmacist" | "hold";

export type SlmcRefusal = {
  code: SlmcRefusalCode;
  title: string;
  /** The server's own explanation, kept: it names the pharmacist. */
  detail: string;
  /** What to do next, in the counter's words. */
  next: string;
  actions: RefusalAction[];
};

/**
 * The three SLMC refusals, said for the counter. All three are final: desktop main does not keep
 * the sale or the command pending for them (definite-refusal.ts, signed-commands.ts), so the
 * person can fix it and try again straight away.
 */
export function slmcRefusal(
  code: SlmcRefusalCode,
  detail: string,
  approverName?: string,
): SlmcRefusal {
  switch (code) {
    case "APPROVER_NOT_QUALIFIED":
      return {
        code,
        title: `${approverName ?? "This pharmacist"} can't co-sign controlled medicines`,
        detail,
        next: "Choose another pharmacist and ask for their PIN, or hold the sale until a registered pharmacist is here. Nothing was charged.",
        actions: ["choose-pharmacist", "hold"],
      };
    case "SELLER_NOT_QUALIFIED":
      return {
        code,
        title: "You can't dispense these medicines yourself",
        detail,
        next: "Choose a registered pharmacist to co-sign with their PIN, or hold the sale for them. Nothing was charged.",
        actions: ["choose-pharmacist", "hold"],
      };
    case "PHARMACIST_REQUIRED":
      return {
        code,
        title: "Only a registered pharmacist can record a prescription",
        detail,
        next: "Choose a registered pharmacist under \"Recorded with\" and ask for their PIN, then save again. Or hold the sale until one is here. Nothing was saved.",
        actions: ["choose-pharmacist", "hold"],
      };
  }
}

// ---- line discounts (P2b #103) ----

export type DiscountMode = "percent" | "amount";

/**
 * The discount, in cents, that a typed value gives off a line of `grossMinor`: a percent of the
 * line (rounded half up to the cent) or an amount. Null when it isn't a usable discount: empty,
 * not a number, or more than the line.
 */
export function discountFromInput(mode: DiscountMode, raw: string, grossMinor: number): number | null {
  const text = raw.trim();
  if (!text || !/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const value = Number(text);
  const discount = mode === "percent" ? Math.round((grossMinor * Math.round(value * 100)) / 10_000) : Math.round(value * 100);
  if (mode === "percent" && value > 100) return null;
  return discount >= 0 && discount <= grossMinor ? discount : null;
}

/** The discount as a percent of the line, to two places: 1250 off 12500 → 10. */
export function discountPercent(discountMinor: number, grossMinor: number): number {
  if (grossMinor <= 0) return 0;
  return Math.round((discountMinor / grossMinor) * 10_000) / 100;
}

/**
 * Whether a discount is above the branch's limit and so needs a manager, the way the server
 * decides: the line's percent strictly above `posMaxDiscountPercent`. Compared in whole numbers,
 * so exactly 10% of a line is never read as 10.0000001%.
 */
export function overDiscountLimit(discountMinor: number, grossMinor: number, limitPercent: number): boolean {
  if (discountMinor <= 0 || grossMinor <= 0) return false;
  return discountMinor * 10_000 > Math.round(limitPercent * 100) * grossMinor;
}

/** "10%", "12.5%": a percent the way the counter writes it. */
export const percentText = (value: number) => `${Number(value.toFixed(2))}%`;

/** Refusals that mean the manager's discount co-sign is needed again or was not accepted. */
export const isDiscountRefusal = (code: string) =>
  code === "DISCOUNT_APPROVAL_REQUIRED" || code === "DISCOUNT_COSIGN_REFUSED";
