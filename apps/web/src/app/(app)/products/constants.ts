import type { CatalogSource, ColumnKey, StatFilter } from "./types";

export const PAGE_SIZE = 10;
export const COLUMN_STORAGE_KEY = "pc-products-visible-columns-v3";

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);

export const CATALOG_SOURCE_OPTIONS: { value: CatalogSource; label: string }[] = [
  { value: "MANUAL", label: "Retail / general item" },
  { value: "NMRA", label: "NMRA-registered medicine" },
  { value: "SUPPLIER", label: "Supplier-supplied" },
  { value: "CSV_IMPORT", label: "CSV import" },
  { value: "BARCODE", label: "Barcode lookup" },
];

export const INITIAL_FORM = {
  sku: "",
  source: "MANUAL" as CatalogSource,
  barcode: "",
  name: "",
  genericName: "",
  brandName: "",
  manufacturer: "",
  dosageForm: "",
  strength: "",
  unit: "",
  packSize: "",
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
