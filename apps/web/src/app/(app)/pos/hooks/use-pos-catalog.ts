"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/use-auth";
import { fetchPosCatalog, fetchRecentSales } from "../services/pos-api";
import type { PosCatalog, PosProduct, RecentSale } from "../types";

const EMPTY: PosCatalog = { vatRatePercent: 0, nearExpiryDays: 30, products: [], departments: [] };

/** Loads the branch's sellable catalog plus recent sales; reloads after every posted sale. */
export function usePosCatalog() {
  const { branchId } = useAuth();
  const [catalog, setCatalog] = useState<PosCatalog>(EMPTY);
  const [recentSales, setRecentSales] = useState<RecentSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!branchId) {
      setCatalog(EMPTY);
      setRecentSales([]);
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    try {
      const [next, sales] = await Promise.all([
        fetchPosCatalog(),
        fetchRecentSales().catch(() => [] as RecentSale[]),
      ]);
      if (id !== requestId.current) return;
      setCatalog(next);
      setRecentSales(sales);
      setError(null);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : "Could not load the POS catalog");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const productsById = useMemo(() => {
    const map = new Map<string, PosProduct>();
    for (const p of catalog.products) map.set(p.id, p);
    return map;
  }, [catalog.products]);

  return {
    catalog,
    products: catalog.products,
    departments: catalog.departments,
    productsById,
    vatRatePercent: catalog.vatRatePercent,
    recentSales,
    loading,
    error,
    hasBranch: Boolean(branchId),
    reload: load,
  };
}
