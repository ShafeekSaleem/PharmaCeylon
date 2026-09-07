import { apiJson } from "@/lib/auth-client";
import type { CommercialCategoryNode, OnboardingGroupStatus } from "./types";

export function fetchCommercialTree(): Promise<CommercialCategoryNode[]> {
  return apiJson<CommercialCategoryNode[]>("/products/commercial-categories/tree");
}

export function fetchOnboardingStatus(): Promise<OnboardingGroupStatus[]> {
  return apiJson<OnboardingGroupStatus[]>("/products/commercial-categories/onboarding");
}

export function applyOnboardingSelection(departments: string[]): Promise<OnboardingGroupStatus[]> {
  return apiJson<OnboardingGroupStatus[]>("/products/commercial-categories/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ departments }),
  });
}

export function createCategory(
  name: string,
  parentCategoryId: string | null,
): Promise<CommercialCategoryNode> {
  return apiJson<CommercialCategoryNode>("/products/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parentCategoryId }),
  });
}

export function updateCategory(
  id: string,
  patch: { name?: string; isActive?: boolean; parentCategoryId?: string | null; sortOrder?: number },
): Promise<CommercialCategoryNode> {
  return apiJson<CommercialCategoryNode>(`/products/categories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteCategory(id: string): Promise<{ ok: true }> {
  return apiJson(`/products/categories/${id}`, { method: "DELETE" });
}

/** Product ids currently mapped to a commercial category — capped at 200 for the "move all" action. */
export async function fetchProductIdsInCategory(categoryId: string): Promise<string[]> {
  const data = await apiJson<{ items: { id: string }[]; total: number }>(
    `/products?commercialCategoryId=${categoryId}&status=all&take=200`,
  );
  return data.items.map((p) => p.id);
}

export function moveProductsCategory(productIds: string[], toCategoryId: string): Promise<{ ok: true; moved: number }> {
  return apiJson("/products/commercial-categories/move-products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productIds, toCategoryId }),
  });
}
