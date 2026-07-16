"use client";

import { useCallback, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { ProductCategory, ProductTag } from "../types";

export function useProductMetaMutations(onRefresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrap = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        const result = await fn();
        onRefresh();
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onRefresh],
  );

  const createCategory = useCallback(
    (name: string) =>
      wrap(() =>
        apiJson<ProductCategory>("/products/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }),
      ),
    [wrap],
  );

  const updateCategory = useCallback(
    (id: string, name: string) =>
      wrap(() =>
        apiJson<ProductCategory>(`/products/categories/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }),
      ),
    [wrap],
  );

  const deleteCategory = useCallback(
    (id: string) => wrap(() => apiJson(`/products/categories/${id}`, { method: "DELETE" })),
    [wrap],
  );

  const createTag = useCallback(
    (name: string) =>
      wrap(() =>
        apiJson<ProductTag>("/products/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }),
      ),
    [wrap],
  );

  const updateTag = useCallback(
    (id: string, name: string) =>
      wrap(() =>
        apiJson<ProductTag>(`/products/tags/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }),
      ),
    [wrap],
  );

  const deleteTag = useCallback(
    (id: string) => wrap(() => apiJson(`/products/tags/${id}`, { method: "DELETE" })),
    [wrap],
  );

  return {
    busy,
    error,
    setError,
    createCategory,
    updateCategory,
    deleteCategory,
    createTag,
    updateTag,
    deleteTag,
  };
}
