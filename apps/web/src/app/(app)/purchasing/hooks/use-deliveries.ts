"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { DeliveryRow } from "../types";

export type DeliveryFilters = {
  supplierId?: string;
  from?: string;
  to?: string;
  q?: string;
};

/**
 * Deliveries for the selected branch. The server filters, because a busy branch has more of
 * these than a page should ever hold in memory, and the date range is the filter people
 * actually reach for ("what came in last week?").
 */
export function useDeliveries(filters: DeliveryFilters) {
  const { branchId } = useAuth();
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { supplierId, from, to, q } = filters;

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
      if (supplierId) params.set("supplierId", supplierId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (q?.trim()) params.set("q", q.trim());
      const qs = params.toString();
      const data = await apiJson<DeliveryRow[]>(
        `/purchasing/deliveries${qs ? `?${qs}` : ""}`,
      );
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deliveries");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, supplierId, from, to, q]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, hasBranch: !!branchId };
}
