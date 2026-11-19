import type { Product } from "../types";

/**
 * Pure rules behind the Products list cells (#205, Products). Kept apart from the JSX so each
 * rule is pinned by a plain test.
 */

export type ScheduleKind = "otc" | "rx" | "controlled";

export type ScheduleBadgeInfo = {
  kind: ScheduleKind;
  /** What the badge says: "OTC", "Rx · II B", "Controlled · III". */
  label: string;
  /** The longer wording, for the tooltip and the accessible name. */
  description: string;
};

/**
 * One badge per row for how the product may be sold. It replaces three things that used to
 * say overlapping parts of this: an "Rx" tag, a "Prescription required" tag chip and a separate
 * Schedule column. Controlled wins over Rx (a controlled medicine always needs a prescription).
 */
export function scheduleBadge(
  row: Pick<Product, "isControlled" | "requiresPrescription" | "schedule">,
): ScheduleBadgeInfo {
  const schedule = row.schedule?.trim() || null;
  const suffix = schedule ? ` · ${schedule}` : "";
  const scheduleWords = schedule ? `, schedule ${schedule}` : "";
  if (row.isControlled) {
    return {
      kind: "controlled",
      label: `Controlled${suffix}`,
      description: `Controlled medicine${scheduleWords}`,
    };
  }
  if (row.requiresPrescription) {
    return {
      kind: "rx",
      label: `Rx${suffix}`,
      description: `Prescription required${scheduleWords}`,
    };
  }
  return {
    kind: "otc",
    label: "OTC",
    description: `Over the counter, no prescription needed${scheduleWords}`,
  };
}

function same(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/** The brand, unless it only repeats the product name (most register imports). */
export function distinctBrand(row: Pick<Product, "brandName" | "name">): string | null {
  const brand = row.brandName?.trim();
  if (!brand || same(brand, row.name)) return null;
  return brand;
}

/** The SKU, unless it only repeats the registration number (register imports use it as SKU). */
export function distinctSku(row: Pick<Product, "sku" | "registrationNo">): string | null {
  const sku = row.sku?.trim();
  if (!sku || same(sku, row.registrationNo)) return null;
  return sku;
}

/** The generic name for the muted second line, unless it only repeats the name. */
export function distinctGeneric(row: Pick<Product, "genericName" | "name">): string | null {
  const generic = row.genericName?.trim();
  if (!generic || same(generic, row.name)) return null;
  return generic;
}

export type StockCellInfo = {
  /** The number shown, or null when no branch is selected. */
  qty: number | null;
  /** Only zero and low are coloured; everything else is plain text. */
  tone: "out" | "low" | null;
  /** A short muted note under the number. */
  note: string | null;
  /** Full wording for screen readers and the tooltip, so nothing rests on colour. */
  description: string;
};

export function stockCell(
  row: Pick<Product, "qtyOnHand" | "stockStatus" | "reorderLevel" | "reorderGap">,
): StockCellInfo {
  const qty = row.qtyOnHand;
  if (qty === null || qty === undefined) {
    return {
      qty: null,
      tone: null,
      note: null,
      description: "Select a branch to see stock",
    };
  }
  const units = qty === 1 ? "unit" : "units";
  const reorderAt = row.reorderLevel > 0 ? `reorder at ${row.reorderLevel}` : null;
  if (row.stockStatus === "out" || qty <= 0) {
    return {
      qty,
      tone: "out",
      note: "Out of stock",
      description: `${qty} ${units}, out of stock`,
    };
  }
  if (row.stockStatus === "low") {
    const note = reorderAt ? `Low · ${reorderAt}` : "Low";
    return {
      qty,
      tone: "low",
      note,
      description: `${qty} ${units}, low stock${reorderAt ? `, ${reorderAt}` : ""}`,
    };
  }
  return {
    qty,
    tone: null,
    note: reorderAt ? capitalise(reorderAt) : null,
    description: `${qty} ${units}${reorderAt ? `, ${reorderAt}` : ""}`,
  };
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
