"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSalesHistory, fetchSalesHistoryOptions } from "../services/sales-api";
import type { SaleListRow, SalesFilters, SalesHistoryOptions } from "../types";

/**
 * One page of sales history. `branchId` is the branch picked in the top bar: with the branch
 * filter on "current" the API reads it from the request header, so switching branches has to
 * refetch even though no filter changed.
 */
export function useSalesHistory(filters: SalesFilters, page: number, branchId: string | null) {
  const [items, setItems] = useState<SaleListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A slower, older response must never overwrite the result of a newer filter.
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSalesHistory(filters, page);
      if (requestId !== requestIdRef.current) return;
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load sales");
      setItems([]);
      setTotal(0);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [filters, page]);

  // `branchId` isn't sent, but with the branch filter on "current" it changes the answer.
  useEffect(() => {
    void reload();
  }, [reload, branchId]);

  return { items, total, loading, error, reload };
}

/** Branches the caller can view sales at, and the staff who sold there — for the filters. */
export function useSalesHistoryOptions() {
  const [options, setOptions] = useState<SalesHistoryOptions>({ branches: [], sellers: [] });

  useEffect(() => {
    let cancelled = false;
    fetchSalesHistoryOptions()
      .then((next) => {
        if (!cancelled) setOptions(next);
      })
      // The list still works without its filter options; it just can't offer them.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return options;
}
