"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/use-auth";
import { fetchRecentSales } from "../services/pos-api";
import type { RecentSale } from "../types";

/** The branch's sales since the start of the tenant's business day, newest first. */
export function usePosTodaySales() {
  const { branchId } = useAuth();
  const [sales, setSales] = useState<RecentSale[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!branchId) {
      setSales([]);
      return;
    }
    setLoading(true);
    try {
      setSales(await fetchRecentSales(500, true));
    } catch {
      // The till still works without it; the card just says there's nothing to show.
      setSales([]);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { sales, loading, reload };
}
