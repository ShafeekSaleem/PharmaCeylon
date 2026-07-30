import { COLUMN_META, COLUMN_STORAGE_KEY, DEFAULT_VISIBLE, DELETE_ROLES, WRITE_ROLES } from "./constants";
import type { ColumnKey, Product, ProductForm } from "./types";

/**
 * Branch-scoped, mirroring the API's `RolesGuard` (owner on *any* branch
 * bypasses; otherwise roles are scoped to the currently selected branch).
 * Note: `user.roles` is a flattened union across *all* branches and must not
 * be used here directly, or a user with e.g. `inventory_clerk` at another
 * branch would see write access enabled while viewing a branch where they
 * hold no such role.
 */
export function hasWriteAccess(
  user: { branchRoles: { branchId: string; role: string }[] } | null,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (user.branchRoles.some((br) => br.role === "owner")) return true;
  const scoped = branchId
    ? user.branchRoles.filter((br) => br.branchId === branchId)
    : user.branchRoles;
  return scoped.some((br) => WRITE_ROLES.has(br.role));
}

/**
 * Products/categories/tags DELETE endpoints are owner/manager only on the API
 * (inventory_clerk can create/edit but not delete). Use this — not
 * `hasWriteAccess` — to gate delete actions so the UI doesn't offer a control
 * that the API will reject with 403.
 */
export function hasDeleteAccess(
  user: { branchRoles: { branchId: string; role: string }[] } | null,
  branchId?: string | null,
): boolean {
  if (!user) return false;
  if (user.branchRoles.some((br) => br.role === "owner")) return true;
  const scoped = branchId
    ? user.branchRoles.filter((br) => br.branchId === branchId)
    : user.branchRoles;
  return scoped.some((br) => DELETE_ROLES.has(br.role));
}

export function formToBody(form: ProductForm, isEdit: boolean) {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    barcode: form.barcode.trim() || null,
    genericName: form.genericName.trim() || null,
    brandName: form.brandName.trim() || null,
    manufacturer: form.manufacturer.trim() || null,
    dosageForm: form.dosageForm.trim() || null,
    strength: form.strength.trim() || null,
    unit: form.unit.trim() || null,
    packSize: form.packSize.trim() || null,
    storage: form.storage.trim() || null,
    shelfLife: form.shelfLife.trim() || null,
    taxCategory: form.taxCategory.trim() || null,
    imageUrl: form.imageUrl || null,
    reorderLevel: form.reorderLevel,
    isControlled: form.isControlled,
    categoryIds: form.categoryIds,
    tagIds: form.tagIds,
  };
  if (!isEdit) {
    body.sku = form.sku.trim();
  } else {
    body.isActive = form.isActive;
  }
  return body;
}

export function productToForm(product: Product): ProductForm {
  return {
    sku: product.sku,
    barcode: product.barcode ?? "",
    name: product.name,
    genericName: product.genericName ?? "",
    brandName: product.brandName ?? "",
    manufacturer: product.manufacturer ?? "",
    dosageForm: product.dosageForm ?? "",
    strength: product.strength ?? "",
    unit: product.unit ?? "",
    packSize: product.packSize ?? "",
    storage: product.storage ?? "",
    shelfLife: product.shelfLife ?? "",
    taxCategory: product.taxCategory ?? "",
    imageUrl: product.imageUrl,
    reorderLevel: product.reorderLevel,
    isControlled: product.isControlled,
    isActive: product.isActive,
    categoryIds: product.categories?.map((c) => c.id) ?? [],
    tagIds: product.tags?.map((t) => t.id) ?? [],
  };
}

export function loadVisibleColumns(): Set<ColumnKey> {
  if (typeof window === "undefined") return new Set(DEFAULT_VISIBLE);
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE);
    const parsed = JSON.parse(raw) as ColumnKey[];
    const next = new Set<ColumnKey>();
    for (const key of parsed) {
      if (COLUMN_META.some((c) => c.key === key)) next.add(key);
    }
    for (const c of COLUMN_META) {
      if (!c.hideable) next.add(c.key);
    }
    return next.size > 0 ? next : new Set(DEFAULT_VISIBLE);
  } catch {
    return new Set(DEFAULT_VISIBLE);
  }
}

export function stockStatusLabel(status: Product["stockStatus"]): string {
  if (status === "out") return "Out of stock";
  if (status === "low") return "Low stock";
  if (status === "ok") return "Healthy";
  return "—";
}

function escapeCsv(value: string | number | boolean | null | undefined): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Build a CSV for the current products page (same pattern as inventory/purchasing). */
export function productsToCsv(products: Product[]): string {
  const header = [
    "SKU",
    "Name",
    "Generic name",
    "Brand",
    "Manufacturer",
    "Dosage form",
    "Strength",
    "Unit",
    "Barcode",
    "Categories",
    "Status",
    "Controlled",
    "Reorder level",
    "Qty on hand",
    "Stock status",
  ];
  const rows = products.map((p) => [
    p.sku,
    p.name,
    p.genericName,
    p.brandName,
    p.manufacturer,
    p.dosageForm,
    p.strength,
    p.unit,
    p.barcode,
    (p.categories ?? []).map((c) => c.name).join("; "),
    p.isActive ? "Active" : "Inactive",
    p.isControlled ? "Yes" : "No",
    p.reorderLevel,
    p.qtyOnHand ?? "",
    stockStatusLabel(p.stockStatus),
  ]);
  return [header, ...rows].map((line) => line.map(escapeCsv).join(",")).join("\n");
}

export function downloadProductsCsv(products: Product[]): void {
  if (products.length === 0) return;
  const csv = productsToCsv(products);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `products-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
