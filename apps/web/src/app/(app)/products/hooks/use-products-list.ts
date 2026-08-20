"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { PAGE_SIZE } from "../constants";
import {
  productFiltersToQueryParams,
  type FilterFacets,
  type ProductFilters,
} from "../products-filter-panel";
import type { Product, ProductList, SummaryFacets } from "../types";

/** Shared filter/search/sort query params (list, facets, and full CSV export). */
export function buildProductFilterParams(
  q: string,
  filters: ProductFilters,
  sortBy?: string,
  sortDir?: string,
) {
  const filterParams = productFiltersToQueryParams(filters);
  const params = new URLSearchParams({ status: filterParams.status });
  if (sortBy) {
    params.set("sortBy", sortBy);
    params.set("sortDir", sortDir || "asc");
  }
  if (q) params.set("q", q);
  if (filterParams.brandName) params.set("brandName", filterParams.brandName);
  if (filterParams.schedule) params.set("schedule", filterParams.schedule);
  if (filterParams.categoryId) params.set("categoryId", filterParams.categoryId);
  if (filterParams.commercialCategoryId) params.set("commercialCategoryId", filterParams.commercialCategoryId);
  if (filterParams.tagId) params.set("tagId", filterParams.tagId);
  if (filterParams.isControlled) params.set("isControlled", filterParams.isControlled);
  if (filterParams.lowStock) params.set("lowStock", "true");
  if (filterParams.requiresPrescription) params.set("requiresPrescription", "true");
  return params;
}

function buildListParams(
  page: number,
  q: string,
  filters: ProductFilters,
  sortBy: string,
  sortDir: string,
) {
  const skip = (page - 1) * PAGE_SIZE;
  const params = buildProductFilterParams(q, filters, sortBy, sortDir);
  params.set("skip", String(skip));
  params.set("take", String(PAGE_SIZE));
  return params;
}

function buildFacetsParams(filters: ProductFilters, q: string) {
  return buildProductFilterParams(q, filters);
}

export function useProductsList(
  page: number,
  debouncedQ: string,
  appliedFilters: ProductFilters,
  sortBy: string,
  sortDir: string,
) {
  const { branchId } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [summaryFacets, setSummaryFacets] = useState<SummaryFacets | null>(null);
  const [filterFacets, setFilterFacets] = useState<FilterFacets | null>(null);
  const [totalAll, setTotalAll] = useState<number | null>(null);

  const fetchProducts = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    const params = buildListParams(page, debouncedQ, appliedFilters, sortBy, sortDir);
    apiJson<ProductList>(`/products?${params}`)
      .then((data) => {
        if (!cancelled) {
          setProducts(data.items);
          setTotal(data.total);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : "Failed to load products");
          setProducts([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, debouncedQ, appliedFilters, sortBy, sortDir]);

  useEffect(() => fetchProducts(), [fetchProducts, branchId]);

  const refreshStats = useCallback(() => {
    apiJson<SummaryFacets>("/catalog/facets?status=all")
      .then(setSummaryFacets)
      .catch(() => {});
    apiJson<ProductList>("/products?take=0&status=all")
      .then((d) => setTotalAll(d.total))
      .catch(() => {});
  }, []);

  const fetchFilterFacets = useCallback(() => {
    const params = buildFacetsParams(appliedFilters, debouncedQ);
    apiJson<FilterFacets>(`/catalog/facets?${params}`)
      .then(setFilterFacets)
      .catch(() => {});
  }, [appliedFilters, debouncedQ]);

  useEffect(() => {
    refreshStats();
  }, [refreshStats, branchId]);

  useEffect(() => {
    fetchFilterFacets();
  }, [fetchFilterFacets]);

  const controlledCount = useMemo(() => {
    const entry = summaryFacets?.controlled.find((c) => c.value === true);
    return entry?.count ?? 0;
  }, [summaryFacets]);

  const rxCount = useMemo(() => {
    const entry = summaryFacets?.requiresPrescription?.find((c) => c.value === true);
    return entry?.count ?? 0;
  }, [summaryFacets]);

  const activeCount = useMemo(() => {
    const entry = summaryFacets?.status?.find((s) => s.value === "active");
    if (entry) return entry.count;
    return totalAll ?? total;
  }, [summaryFacets, total, totalAll]);

  const inactiveCount = useMemo(() => {
    const entry = summaryFacets?.status?.find((s) => s.value === "inactive");
    if (entry) return entry.count;
    if (totalAll != null && activeCount != null) {
      return Math.max(0, totalAll - activeCount);
    }
    return 0;
  }, [summaryFacets, totalAll, activeCount]);

  const lowStock = summaryFacets?.branchStockSummary?.lowStockProductCount;

  const reload = useCallback(() => {
    fetchProducts();
    refreshStats();
    fetchFilterFacets();
  }, [fetchProducts, refreshStats, fetchFilterFacets]);

  const patchProductInList = useCallback((updated: Product) => {
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  return {
    products,
    setProducts,
    total,
    loading,
    listError,
    summaryFacets,
    filterFacets,
    totalAll,
    controlledCount,
    rxCount,
    activeCount,
    inactiveCount,
    lowStock,
    reload,
    patchProductInList,
  };
}
