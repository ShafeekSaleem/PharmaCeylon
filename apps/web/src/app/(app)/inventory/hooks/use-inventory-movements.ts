"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { MovementCategory, MovementList } from "../types";

type Options = {
  productId?: string | null;
  category?: MovementCategory;
  skip?: number;
  take?: number;
};

export function useInventoryMovements(opts: Options) {
  const { branchId } = useAuth();
  const [data, setData] = useState<MovementList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!branchId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (opts.productId) params.set("productId", opts.productId);
    if (opts.category && opts.category !== "all") params.set("category", opts.category);
    if (opts.skip) params.set("skip", String(opts.skip));
    if (opts.take) params.set("take", String(opts.take));
    const qs = params.toString();
    apiJson<MovementList>(`/inventory/movements${qs ? `?${qs}` : ""}`)
      .then(setData)
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load movements");
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [branchId, opts.productId, opts.category, opts.skip, opts.take]);

  useEffect(() => {
    reload();
  }, [reload]);

  return {
    rows: data?.items ?? [],
    total: data?.total ?? 0,
    summary: data?.summary ?? { unitsIn: 0, unitsOut: 0, netDelta: 0 },
    skip: data?.skip ?? 0,
    take: data?.take ?? 50,
    loading,
    error,
    hasBranch: !!branchId,
    reload,
  };
}
