import type { ColumnKey } from "./types";

export const PAGE_SIZE = 10;
export const COLUMN_STORAGE_KEY = "pc-products-visible-columns";

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);

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
  { key: "image", label: "Image", hideable: false },
  { key: "sku", label: "SKU", hideable: true },
  { key: "name", label: "Name", hideable: true },
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
  "image",
  "sku",
  "name",
  "brandName",
  "dosageForm",
  "stock",
  "reorderLevel",
  "status",
  "actions",
]);

export const PRODUCT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
