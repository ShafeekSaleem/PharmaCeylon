"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { StocktakeListItem } from "../types";

type ReloadOpts = {
  /** Soft reload keeps the current view mounted (no full-page loading flash). */
  soft?: boolean;
};

export function useStocktakeDetail(stocktakeId: string | undefined) {
  const [data, setData] = useState<StocktakeListItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (opts?: ReloadOpts) => {
      if (!stocktakeId) {
        setData(null);
        setLoading(false);
        setError("Stocktake not found");
        return null;
      }
      const soft = opts?.soft === true;
      if (!soft) setLoading(true);
      setError(null);
      try {
        const next = await apiJson<StocktakeListItem>(`/stocktakes/${stocktakeId}`);
        setData(next);
        return next;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load stocktake");
        if (!soft) setData(null);
        return null;
      } finally {
        if (!soft) setLoading(false);
      }
    },
    [stocktakeId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
}
