"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type {
  InventorySummary,
  StockRow,
  StockStatusFilter,
  SummaryPeriod,
} from "../types";

export function useInventoryStock(status: StockStatusFilter, q: string) {
  const { branchId } = useAuth();
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      const qs = params.toString();
      const data = await apiJson<StockRow[]>(
        `/inventory/stock-by-product${qs ? `?${qs}` : ""}`,
      );
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stock");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, status, q]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, hasBranch: !!branchId };
}

export function useInventorySummary(period: SummaryPeriod = "this_month") {
  const { branchId } = useAuth();
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!branchId) {
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSummary(
        await apiJson<InventorySummary>(
          `/inventory/summary?period=${encodeURIComponent(period)}`,
        ),
      );
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, period]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { summary, loading, reload };
}
