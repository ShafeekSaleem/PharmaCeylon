import { ADMIN_ROLES } from "@/lib/role-access";
import type { ColumnKey, StatFilter } from "./types";

export const PAGE_SIZE = 10;
export const COLUMN_STORAGE_KEY = "pc-products-visible-columns-v3";

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);
/** Matches API DELETE guards (products, categories, tags are owner/manager only). */
export const DELETE_ROLES = new Set<string>(ADMIN_ROLES);

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
export const PRODUCT_KPI_POOL: {
  id: StatFilter;
  label: string;
  cardTitle: string;
  subtitle: string;
  iconTone: "primary" | "success" | "info" | "warning" | "danger";
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
export const PRODUCT_STAT_PILLS: { id: StatFilter; label: string }[] =
  PRODUCT_KPI_POOL.filter((k) => k.defaultVisible).map((k) => ({
    id: k.id,
    label: k.label,
  }));

export const PRODUCT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
