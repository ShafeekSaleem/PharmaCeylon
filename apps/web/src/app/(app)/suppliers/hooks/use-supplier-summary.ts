"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { SummaryPeriod, SupplierSummary } from "../types";

export function useSupplierSummary(period: SummaryPeriod) {
  const [data, setData] = useState<SupplierSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiJson<SupplierSummary>(`/suppliers/summary?period=${period}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load summary");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
