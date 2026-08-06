"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { PAGE_SIZE } from "../constants";
import type { InventoryCatalogFilters } from "../components/inventory-more-filters";
import type {
  InventorySummary,
  StockListResponse,
  StockRow,
  StockStatusFilter,
  SummaryPeriod,
} from "../types";

export type InventoryStockQuery = {
  status?: StockStatusFilter;
  q?: string;
  page?: number;
  pageSize?: number;
  productId?: string | null;
  controlled?: "all" | "controlled" | "regular";
  batchFilter?: "all" | "expiring" | "with_batches" | "no_batches";
  catalogFilters?: InventoryCatalogFilters;
  ledgerOnly?: boolean;
};

export function useInventoryStock(query: InventoryStockQuery = {}) {
  const { branchId } = useAuth();
  const {
    status = "all",
    q = "",
    page = 1,
    pageSize = PAGE_SIZE,
    productId = null,
    controlled = "all",
    batchFilter = "all",
    catalogFilters,
    ledgerOnly = false,
  } = query;

  const [rows, setRows] = useState<StockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const categoryKey = (catalogFilters?.categories ?? []).join(",");
  const brandKey = (catalogFilters?.brands ?? []).join(",");
  const tagKey = (catalogFilters?.tags ?? []).join(",");
  const dosageKey = (catalogFilters?.dosageForms ?? []).join(",");

  const reload = useCallback(async () => {
    if (!branchId) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("skip", String(Math.max(0, (page - 1) * pageSize)));
      params.set("take", String(pageSize));
      if (status !== "all") params.set("status", status);
      if (q.trim()) params.set("q", q.trim());
      if (productId) params.set("productId", productId);
      if (controlled !== "all") params.set("controlled", controlled);
      if (batchFilter !== "all") params.set("batchFilter", batchFilter);
      if (categoryKey) params.set("categoryIds", categoryKey);
      if (brandKey) params.set("brands", brandKey);
      if (tagKey) params.set("tagIds", tagKey);
      if (dosageKey) params.set("dosageForms", dosageKey);
      if (ledgerOnly) params.set("ledgerOnly", "1");

      const data = await apiJson<StockListResponse>(
        `/inventory/stock-by-product?${params}`,
      );
      setRows(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stock");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [
    branchId,
    status,
    q,
    page,
    pageSize,
    productId,
    controlled,
    batchFilter,
    categoryKey,
    brandKey,
    tagKey,
    dosageKey,
    ledgerOnly,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, total, loading, error, reload, hasBranch: !!branchId };
}

export function useInventorySummary(period: SummaryPeriod = "this_month") {
  const { branchId } = useAuth();
  const [summary, setSummary] = useState<InventorySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!branchId) {
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSummary(
        await apiJson<InventorySummary>(
          `/inventory/summary?period=${encodeURIComponent(period)}`,
        ),
      );
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, period]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { summary, loading, reload };
}
