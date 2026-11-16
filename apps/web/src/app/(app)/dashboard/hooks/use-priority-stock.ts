"use client";

import { useEffect, useState } from "react";
import type { BatchRow, StockRow } from "@/app/(app)/inventory/types";
import { apiJson } from "@/lib/auth-client";
import type { PriorityFilterKey } from "../lib/priority-filters";

type StockLists = {
  low: StockRow[];
  out: StockRow[];
  controlledLow: StockRow[];
  nearExpiry: BatchRow[];
  loading: boolean;
  error: string | null;
};

const TAKE = 200;

export function usePriorityStock(
  branchId: string | null,
  refreshKey: string | null,
  _enabled: boolean,
): StockLists {
  const [low, setLow] = useState<StockRow[]>([]);
  const [out, setOut] = useState<StockRow[]>([]);
  const [controlledLow, setControlledLow] = useState<StockRow[]>([]);
  const [nearExpiry, setNearExpiry] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId) {
      setLow([]);
      setOut([]);
      setControlledLow([]);
      setNearExpiry([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const headers = { "x-branch-id": branchId };
    const signal = controller.signal;
  const stock = (status: string, controlled?: boolean) =>
      apiJson<{ items: StockRow[] }>(
        `/inventory/stock-by-product?ledgerOnly=1&status=${status}&take=${TAKE}${
          controlled ? "&controlled=controlled" : ""
        }`,
        { headers, signal },
      ).then((r) => r.items ?? []);

    void Promise.all([
      stock("low"),
      stock("out"),
      stock("low", true),
      apiJson<{ items: BatchRow[] }>(
        `/inventory/batches?nearExpiryDays=30&includeZero=false&take=${TAKE}`,
        { headers, signal },
      ).then((r) => (r.items ?? []).filter((b) => b.nearExpiry || b.expired)),
    ])
      .then(([lowRows, outRows, ctrlRows, batchRows]) => {
        if (signal.aborted) return;
        setLow(lowRows);
        setOut(outRows);
        setControlledLow(ctrlRows);
        setNearExpiry(batchRows);
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        setError(
          err instanceof Error ? err.message : "Couldn't load stock lists.",
        );
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [branchId, refreshKey]);

  return { low, out, controlledLow, nearExpiry, loading, error };
}

export function stockItemsForFilter(
  lists: Omit<StockLists, "loading" | "error">,
  key: PriorityFilterKey,
): Array<StockRow | BatchRow> {
  switch (key) {
    case "low_stock":
      return lists.low;
    case "out_of_stock":
      return lists.out;
    case "controlled":
      return lists.controlledLow;
    case "near_expiry":
      return lists.nearExpiry;
    default:
      return [];
  }
}