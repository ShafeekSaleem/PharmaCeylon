"use client";

import { useEffect, useState } from "react";
import type { BatchRow, StockRow } from "@/app/(app)/inventory/types";
import { apiJson } from "@/lib/auth-client";
import type { PriorityFilterKey } from "../lib/priority-filters";
import { PRIORITY_LIST_TAKE } from "../lib/priority-list-count";

type StockLists = {
  low: StockRow[];
  out: StockRow[];
  controlledLow: StockRow[];
  controlledOut: StockRow[];
  nearExpiry: BatchRow[];
  loading: boolean;
  error: string | null;
};

export function usePriorityStock(
  branchId: string | null,
  refreshKey: string | null,
  enabled: boolean,
): StockLists {
  const [low, setLow] = useState<StockRow[]>([]);
  const [out, setOut] = useState<StockRow[]>([]);
  const [controlledLow, setControlledLow] = useState<StockRow[]>([]);
  const [controlledOut, setControlledOut] = useState<StockRow[]>([]);
  const [nearExpiry, setNearExpiry] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !branchId) {
      setLow([]);
      setOut([]);
      setControlledLow([]);
      setControlledOut([]);
      setNearExpiry([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const headers = { "x-branch-id": branchId };
    const signal = controller.signal;
    const stock = (status: string, controlled?: boolean) =>
      apiJson<{ items: StockRow[] }>(
        `/inventory/stock-by-product?ledgerOnly=1&status=${status}&take=${PRIORITY_LIST_TAKE}${
          controlled ? "&controlled=controlled" : ""
        }`,
        { headers, signal },
      ).then((r) => r.items ?? []);

    void Promise.all([
      stock("low"),
      stock("out"),
      stock("low", true),
      stock("out", true),
      apiJson<{ items: BatchRow[] }>(
        `/inventory/batches?nearExpiryDays=30&includeZero=false&take=${PRIORITY_LIST_TAKE}`,
        { headers, signal },
      ).then((r) => (r.items ?? []).filter((b) => b.nearExpiry || b.expired)),
    ])
      .then(([lowRows, outRows, ctrlLowRows, ctrlOutRows, batchRows]) => {
        if (signal.aborted) return;
        setLow(lowRows);
        setOut(outRows);
        setControlledLow(ctrlLowRows);
        setControlledOut(ctrlOutRows);
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
  }, [branchId, refreshKey, enabled]);

  return {
    low,
    out,
    controlledLow,
    controlledOut,
    nearExpiry,
    loading,
    error,
  };
}

function mergeControlledStock(
  lowRows: StockRow[],
  outRows: StockRow[],
): StockRow[] {
  const seen = new Set<string>();
  const merged: StockRow[] = [];
  for (const row of [...outRows, ...lowRows]) {
    if (seen.has(row.productId)) continue;
    seen.add(row.productId);
    merged.push(row);
  }
  return merged;
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
      return mergeControlledStock(lists.controlledLow, lists.controlledOut);
    case "near_expiry":
      return lists.nearExpiry;
    default:
      return [];
  }
}

export function stockListForChipCount(
  lists: Omit<StockLists, "loading" | "error">,
  key: PriorityFilterKey,
): Array<StockRow | BatchRow> {
  return stockItemsForFilter(lists, key);
}