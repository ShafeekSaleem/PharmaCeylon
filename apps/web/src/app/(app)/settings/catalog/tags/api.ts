import { apiJson } from "@/lib/auth-client";
import type { ProductTag } from "../../../products/types";

export function fetchTags(): Promise<ProductTag[]> {
  return apiJson<ProductTag[]>("/products/tags");
}

export function createTag(name: string): Promise<ProductTag> {
  return apiJson<ProductTag>("/products/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function updateTag(id: string, name: string): Promise<ProductTag> {
  return apiJson<ProductTag>(`/products/tags/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function deleteTag(id: string): Promise<{ ok: true }> {
  return apiJson(`/products/tags/${id}`, { method: "DELETE" });
}
