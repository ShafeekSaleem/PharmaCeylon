import type { AuthUser } from "@/lib/auth-types";
import { COLUMN_META, DEFAULT_VISIBLE, WRITE_ROLES } from "./constants";
import type { ColumnKey, Product, ProductForm } from "./types";

export function hasWriteAccess(user: { roles: string[]; branchRoles: { role: string }[] } | null): boolean {
  if (!user) return false;
  if (user.roles.some((r) => WRITE_ROLES.has(r))) return true;
  return user.branchRoles.some((br) => WRITE_ROLES.has(br.role));
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
    const raw = localStorage.getItem("pc-products-visible-columns");
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
