"use client";

import { useEffect, useState } from "react";
import { withBranch } from "@/lib/api-branch";
import { apiJson } from "@/lib/auth-client";
import type { ChartPoint } from "../components/simple-charts";

type TrendResponse = {
  points: Array<{ label: string; receivedValue: number; issuedValue: number }>;
  netValueTotal: number;
};

export type StockValueTrend = {
  /** Cumulative net stock-value flow this week (Mon → today), for the hero sparkline. */
  sparkline: ChartPoint[];
  netValueTotal: number;
};

/** Cumulative net stock-value flow this week — Inventory clerk hero sparkline/trend. */
export function useStockValueTrend(branchId: string | null | undefined) {
  const [data, setData] = useState<StockValueTrend | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!branchId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void apiJson<TrendResponse>(withBranch("/analytics/stock-movement-trend?period=week", branchId))
      .then((res) => {
        if (cancelled) return;
        let running = 0;
        const sparkline: ChartPoint[] = res.points.map((p) => {
          running += p.receivedValue - p.issuedValue;
          return { label: p.label, value: running };
        });
        setData({ sparkline, netValueTotal: res.netValueTotal });
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  return { data, loading };
}
