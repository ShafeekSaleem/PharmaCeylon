"use client";

import { useEffect, useState } from "react";
import { fetchSaleDetail } from "../services/sales-api";
import type { SaleDetail } from "../types";

export function useSaleDetail(id: string | undefined) {
  const [data, setData] = useState<SaleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSaleDetail(id)
      .then((sale) => {
        if (!cancelled) setData(sale);
      })
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(err instanceof Error ? err.message : "Failed to load the sale");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return { data, loading, error };
}
