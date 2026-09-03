"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { SupplierOption } from "../types";

export function useSuppliers() {
  const [rows, setRows] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<(SupplierOption & { status?: string })[]>(
        "/suppliers?status=active",
      );
      setRows(data.filter((s) => s.isActive !== false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load suppliers");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload };
}

export type ProductOption = {
  id: string;
  sku: string;
  name: string;
  isActive: boolean;
};

export function useProductOptions() {
  const [rows, setRows] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<{ items: ProductOption[] }>(
        // RANGED only: a purchase-order line picker is a transaction surface, so the
        // imported NMRA registry stays out of it. Receiving stock against a reference
        // product promotes it, which is the intended way in.
        "/products?take=200&status=active&rangeStatus=RANGED",
      );
      setRows(data.items.filter((p) => p.isActive !== false));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load products");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload };
}
