"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { ProductStockDetail } from "../types";

/** One product's stock at the selected branch, for the stock sheet. Null id = closed. */
export function useProductStock(productId: string | null) {
  const { branchId } = useAuth();
  const [detail, setDetail] = useState<ProductStockDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId || !productId) {
      setDetail(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDetail(await apiJson<ProductStockDetail>(`/inventory/products/${productId}/stock`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load this product's stock");
    } finally {
      setLoading(false);
    }
  }, [branchId, productId]);

  useEffect(() => {
    setDetail(null);
    void reload();
  }, [reload]);

  return { detail, loading, error, reload };
}
