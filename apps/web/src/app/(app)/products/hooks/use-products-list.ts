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
import type { Product, ProductList, ProductScope, SummaryFacets } from "../types";

/** Products page tab -> the API's `rangeStatus` filter value. */
export function scopeToRangeStatus(scope: ProductScope): "RANGED" | "REFERENCE" {
  return scope === "reference" ? "REFERENCE" : "RANGED";
}

/** Shared filter/search/sort query params (list, facets, and full CSV export). */
export function buildProductFilterParams(
  q: string,
  filters: ProductFilters,
  sortBy?: string,
  sortDir?: string,
  scope: ProductScope = "mine",
) {
  const filterParams = productFiltersToQueryParams(filters);
  const params = new URLSearchParams({ status: filterParams.status });
  params.set("rangeStatus", scopeToRangeStatus(scope));
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
  scope: ProductScope,
) {
  const skip = (page - 1) * PAGE_SIZE;
  const params = buildProductFilterParams(q, filters, sortBy, sortDir, scope);
  params.set("skip", String(skip));
  params.set("take", String(PAGE_SIZE));
  return params;
}

function buildFacetsParams(filters: ProductFilters, q: string, scope: ProductScope) {
  return buildProductFilterParams(q, filters, undefined, undefined, scope);
}

export function useProductsList(
  page: number,
  debouncedQ: string,
  appliedFilters: ProductFilters,
  sortBy: string,
  sortDir: string,
  scope: ProductScope = "mine",
) {
  const { branchId } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [summaryFacets, setSummaryFacets] = useState<SummaryFacets | null>(null);
  const [filterFacets, setFilterFacets] = useState<FilterFacets | null>(null);
  const [totalAll, setTotalAll] = useState<number | null>(null);
  /** Unscoped facets, used only for the "My products"/"Reference catalog" tab counts. */
  const [scopeFacets, setScopeFacets] = useState<SummaryFacets | null>(null);
  /** Secondary data (stat tiles, filter facets) — decorative, so a failure here doesn't block
   *  the main product list, but it shouldn't be silently invisible either. */
  const [secondaryError, setSecondaryError] = useState<string | null>(null);

  const fetchProducts = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    const params = buildListParams(
      page,
      debouncedQ,
      appliedFilters,
      sortBy,
      sortDir,
      scope,
    );
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
  }, [page, debouncedQ, appliedFilters, sortBy, sortDir, scope]);

  useEffect(() => fetchProducts(), [fetchProducts, branchId]);

  const refreshStats = useCallback(() => {
    // Stat tiles describe the tab you are looking at, so they follow the scope. The tab
    // counts themselves come from `rangeStatus`, which is deliberately NOT scoped — both
    // numbers have to be visible from either tab.
    const rangeStatus = scopeToRangeStatus(scope);
    apiJson<SummaryFacets>(`/catalog/facets?status=all&rangeStatus=${rangeStatus}`)
      .then((d) => {
        setSummaryFacets(d);
        setSecondaryError(null);
      })
      .catch(() => setSecondaryError("Couldn't load the summary stat tiles."));
    apiJson<ProductList>(`/products?take=0&status=all&rangeStatus=${rangeStatus}`)
      .then((d) => {
        setTotalAll(d.total);
        setSecondaryError(null);
      })
      .catch(() => setSecondaryError("Couldn't load the summary stat tiles."));
    apiJson<SummaryFacets>("/catalog/facets?status=all&rangeStatus=all")
      .then((d) => setScopeFacets(d))
      .catch(() => {
        /* Tab counts are a nicety — the tabs still work without them. */
      });
  }, [scope]);

  const fetchFilterFacets = useCallback(() => {
    const params = buildFacetsParams(appliedFilters, debouncedQ, scope);
    apiJson<FilterFacets>(`/catalog/facets?${params}`)
      .then((d) => {
        setFilterFacets(d);
        setSecondaryError(null);
      })
      .catch(() => setSecondaryError("Couldn't load filter options — some facets may be missing."));
  }, [appliedFilters, debouncedQ, scope]);

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

  const rangedCount = useMemo(
    () => scopeFacets?.rangeStatus?.find((r) => r.value === "RANGED")?.count ?? null,
    [scopeFacets],
  );
  const referenceCount = useMemo(
    () => scopeFacets?.rangeStatus?.find((r) => r.value === "REFERENCE")?.count ?? null,
    [scopeFacets],
  );

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
    secondaryError,
    summaryFacets,
    filterFacets,
    totalAll,
    controlledCount,
    rxCount,
    activeCount,
    inactiveCount,
    lowStock,
    rangedCount,
    referenceCount,
    reload,
    patchProductInList,
  };
}
