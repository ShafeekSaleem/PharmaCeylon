"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { SupplierListItem } from "../types";
import { buildSuppliersQuery } from "../utils";

export function useSuppliersList(filters: {
  q: string;
  status: string;
  type: string;
  paymentTermsDays: string;
}) {
  const [rows, setRows] = useState<SupplierListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = buildSuppliersQuery(filters);
      setRows(await apiJson<SupplierListItem[]>(`/suppliers${qs}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load suppliers");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filters.q, filters.status, filters.type, filters.paymentTermsDays]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload };
}
