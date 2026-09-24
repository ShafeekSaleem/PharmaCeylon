import type { CatalogSource, ColumnKey, StatFilter } from "./types";

export const PAGE_SIZE = 10;
export const COLUMN_STORAGE_KEY = "pc-products-visible-columns-v3";

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);

/**
 * How a product record came into the catalog — provenance, shown read-only.
 *
 * This used to be an editable "Product type" dropdown, which asked the user to choose between
 * things that describe the record's history ("CSV import", "Barcode lookup") and things that
 * describe the product ("Retail / general item"). What a product *is* now comes from its
 * commercial category; this only says where the row came from.
 */
export const CATALOG_SOURCE_LABELS: Record<CatalogSource, string> = {
  MANUAL: "Added by hand",
  NMRA: "NMRA register import",
  SUPPLIER: "Supplier catalog",
  CSV_IMPORT: "Product list import",
  BARCODE: "Barcode lookup",
};

export const INITIAL_FORM = {
  sku: "",
  barcode: "",
  name: "",
  genericName: "",
  brandName: "",
  manufacturer: "",
  dosageForm: "",
  strength: "",
  unit: "",
  packSize: "",
  unitsPerPack: "1",
  packLabel: "",
  packType: "",
  storage: "",
  shelfLife: "",
  taxCategory: "",
  registrationNo: "",
  registrationDate: "",
  schedule: "",
  regType: "",
  dossierNo: "",
  countryOfOrigin: "",
  localAgent: "",
  imageUrl: null as string | null,
  reorderLevel: 0,
  isControlled: false,
  requiresPrescription: false,
  isActive: true,
  categoryIds: [] as string[],
  tagIds: [] as string[],
};

export const COLUMN_META: { key: ColumnKey; label: string; hideable: boolean }[] = [
  { key: "image", label: "Image", hideable: true },
  { key: "sku", label: "SKU", hideable: true },
  { key: "name", label: "Product", hideable: false },
  { key: "brandName", label: "Brand", hideable: true },
  { key: "dosageForm", label: "Form / Strength", hideable: true },
  { key: "manufacturer", label: "Manufacturer", hideable: true },
  { key: "unit", label: "Unit", hideable: true },
  { key: "registrationNo", label: "Reg. no.", hideable: true },
  { key: "schedule", label: "Schedule", hideable: true },
  { key: "stock", label: "Stock", hideable: true },
  { key: "reorderLevel", label: "Reorder level", hideable: true },
  { key: "status", label: "Status", hideable: true },
  { key: "actions", label: "Actions", hideable: false },
];

/**
 * Columns the reference catalog never shows, and never offers in the column picker.
 *
 * A register row cannot hold stock: every path that puts units on a shelf calls
 * `ensureProductsRanged`, which promotes the product into the pharmacy's own range first. So
 * "Stock" is a column of "Not stocked" and "Reorder level" a column of zeroes. "Status" is the
 * same story — every row on the tab is REFERENCE, so it printed the word "Reference" 5,000
 * times; what is worth knowing about a register row (Rx, controlled) is already chipped under
 * its name.
 */
export const REFERENCE_HIDDEN_COLUMNS = new Set<ColumnKey>([
  "stock",
  "reorderLevel",
  "status",
]);

export const DEFAULT_VISIBLE = new Set<ColumnKey>([
  "name",
  "sku",
  "brandName",
  "dosageForm",
  "registrationNo",
  "schedule",
  "stock",
  "status",
  "actions",
]);

/**
 * Selectable KPI pool for the Products page.
 * Settings can later let users pick which cards show; `defaultVisible` is the current row.
 * Keep filter wiring for every pool id (including hidden ones like `rx`).
 */
export type KpiIconTone = "primary" | "success" | "info" | "warning" | "danger";

export const PRODUCT_KPI_POOL: {
  id: StatFilter;
  label: string;
  cardTitle: string;
  subtitle: string;
  iconTone: KpiIconTone;
  defaultVisible: boolean;
}[] = [
  {
    id: "all",
    label: "All",
    cardTitle: "Total Products",
    subtitle: "In catalog",
    iconTone: "primary",
    defaultVisible: true,
  },
  {
    id: "active",
    label: "Active",
    cardTitle: "Active Products",
    subtitle: "Sellable SKUs",
    iconTone: "success",
    defaultVisible: true,
  },
  {
    id: "inactive",
    label: "Inactive",
    cardTitle: "Inactive Products",
    subtitle: "Hidden from sell",
    iconTone: "info",
    defaultVisible: true,
  },
  {
    id: "controlled",
    label: "Controlled",
    cardTitle: "Controlled Substances",
    subtitle: "Restricted items",
    iconTone: "warning",
    defaultVisible: true,
  },
  {
    id: "lowStock",
    label: "Low stock",
    cardTitle: "Low Stock",
    subtitle: "Below reorder level",
    iconTone: "danger",
    defaultVisible: true,
  },
  {
    id: "rx",
    label: "Rx required",
    cardTitle: "Rx Required",
    subtitle: "Needs prescription",
    iconTone: "info",
    defaultVisible: false,
  },
];

export const DEFAULT_PRODUCT_KPI_IDS: StatFilter[] = PRODUCT_KPI_POOL.filter(
  (k) => k.defaultVisible,
).map((k) => k.id);

/** Quick status pills — defaults match visible cards (Rx stays in pool for Settings). */
export const PRODUCT_STAT_PILLS: { id: StatFilter; label: string; iconTone: KpiIconTone }[] =
  PRODUCT_KPI_POOL.filter((k) => k.defaultVisible).map((k) => ({
    id: k.id,
    label: k.label,
    iconTone: k.iconTone,
  }));

/**
 * Pills for the Reference catalog tab. Active/inactive is the pharmacist's enabled flag and
 * low stock needs stock, so neither applies to a lookup-only registry record — but Rx does,
 * and it has to be here explicitly because it is not in the default visible set.
 */
export const REFERENCE_STAT_PILLS: typeof PRODUCT_STAT_PILLS = PRODUCT_KPI_POOL.filter((k) =>
  ["all", "controlled", "rx"].includes(k.id),
).map((k) => ({ id: k.id, label: k.label, iconTone: k.iconTone }));

export const PRODUCT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
