import { ADMIN_ROLES } from "@/lib/role-access";
import type { ColumnKey, StatFilter } from "./types";

export const PAGE_SIZE = 10;
export const COLUMN_STORAGE_KEY = "pc-products-visible-columns-v2";

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
  storage: "",
  shelfLife: "",
  taxCategory: "",
  imageUrl: null as string | null,
  reorderLevel: 0,
  isControlled: false,
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
  "manufacturer",
  "stock",
  "status",
  "actions",
]);

export const PRODUCT_STAT_PILLS: { id: StatFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "lowStock", label: "Low stock" },
  { id: "controlled", label: "Controlled" },
  { id: "inactive", label: "Inactive" },
];

export const PRODUCT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
