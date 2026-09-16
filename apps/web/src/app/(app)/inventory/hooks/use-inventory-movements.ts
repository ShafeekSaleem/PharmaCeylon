"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { MovementCategory, MovementList } from "../types";

export type MovementFilters = {
  productId?: string | null;
  batchId?: string | null;
  category?: MovementCategory;
  userId?: string | null;
  /** Calendar dates, `YYYY-MM-DD`, inclusive. */
  from?: string | null;
  to?: string | null;
  skip?: number;
  take?: number;
};

export function useInventoryMovements(opts: MovementFilters) {
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
    if (opts.batchId) params.set("batchId", opts.batchId);
    if (opts.category && opts.category !== "all") params.set("category", opts.category);
    if (opts.userId) params.set("userId", opts.userId);
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
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
  }, [
    branchId,
    opts.productId,
    opts.batchId,
    opts.category,
    opts.userId,
    opts.from,
    opts.to,
    opts.skip,
    opts.take,
  ]);

  useEffect(() => {
    reload();
  }, [reload]);

  return {
    rows: data?.items ?? [],
    total: data?.total ?? 0,
    summary: data?.summary ?? { unitsIn: 0, unitsOut: 0, netDelta: 0 },
    balanceAvailable: data?.balanceAvailable ?? false,
    skip: data?.skip ?? 0,
    take: data?.take ?? 50,
    loading,
    error,
    hasBranch: !!branchId,
    reload,
  };
}

/** People who moved stock at this branch in the last year — for the movement history's user filter. */
export function useMovementActors() {
  const { branchId } = useAuth();
  const [actors, setActors] = useState<Array<{ id: string; fullName: string }>>([]);
  useEffect(() => {
    if (!branchId) {
      setActors([]);
      return;
    }
    let cancelled = false;
    apiJson<Array<{ id: string; fullName: string }>>("/inventory/movement-actors")
      .then((rows) => {
        if (!cancelled) setActors(rows);
      })
      .catch(() => {
        if (!cancelled) setActors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId]);
  return actors;
}
