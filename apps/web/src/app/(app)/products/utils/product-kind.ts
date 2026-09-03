import type { ProductCategory, ProductForm } from "../types";

/**
 * Is this a medicine or a retail item?
 *
 * Deliberately NOT a column on Product. The answer already exists in the primary COMMERCIAL
 * category — Medicines department or not — which is required for reporting anyway, and a
 * second field would drift from it the first time someone re-categorised a product. The
 * form's toggle picks the department and the layout; the category stays the source of truth.
 */
export type ProductKind = "medicine" | "retail";

/** Canonical key of the seeded Medicines department (see the API's commercial template). */
export const MEDICINES_DEPARTMENT_KEY = "MEDICINES";

export function medicinesDepartment(
  categories: ProductCategory[],
): ProductCategory | null {
  return (
    categories.find(
      (c) => c.canonicalKey === MEDICINES_DEPARTMENT_KEY && !c.parentCategoryId,
    ) ?? null
  );
}

/** The Medicines department plus every category filed underneath it. */
export function medicineCategoryIds(categories: ProductCategory[]): Set<string> {
  const department = medicinesDepartment(categories);
  if (!department) return new Set();
  const ids = new Set([department.id]);
  // The template is two levels deep, but walk it properly so a tenant's own subcategories
  // under Medicines are counted too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of categories) {
      if (c.parentCategoryId && ids.has(c.parentCategoryId) && !ids.has(c.id)) {
        ids.add(c.id);
        changed = true;
      }
    }
  }
  return ids;
}

/** Departments a retail item can be filed under — everything the tenant sells except medicines. */
export function retailDepartments(
  categories: ProductCategory[],
): ProductCategory[] {
  return categories.filter(
    (c) =>
      !c.parentCategoryId &&
      c.canonicalKey !== MEDICINES_DEPARTMENT_KEY &&
      // Departments the pharmacy didn't say it sells stay out of the picker — enabling them
      // is a Settings decision, not something to do by accident while adding a product.
      c.isActive !== false,
  );
}

/**
 * Work out which form a product should be shown in.
 *
 * Primary category first, because that is the field that actually decides it. Falling back on
 * the pharmaceutical fields matters for products imported before any of this existed, which
 * often carry a registration number and no commercial category at all.
 */
export function deriveProductKind(
  form: Pick<
    ProductForm,
    "categoryIds" | "registrationNo" | "genericName" | "dosageForm" | "strength"
  >,
  categories: ProductCategory[],
): ProductKind {
  const primaryId = form.categoryIds[0];
  if (primaryId) {
    const medicineIds = medicineCategoryIds(categories);
    if (medicineIds.size > 0) {
      return medicineIds.has(primaryId) ? "medicine" : "retail";
    }
  }
  const looksPharmaceutical = Boolean(
    form.registrationNo?.trim() ||
      form.genericName?.trim() ||
      form.dosageForm?.trim() ||
      form.strength?.trim(),
  );
  // A pharmacy adding something by hand is adding a medicine far more often than not.
  return looksPharmaceutical || !primaryId ? "medicine" : "retail";
}
