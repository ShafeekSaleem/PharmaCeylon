"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type {
  CatalogFacets,
  CatalogFilters,
  CatalogSearchItem,
  CatalogSearchResponse,
  MatchType,
} from "../types";
import { buildSearchQuery, hasBrowseFilters, pushRecentSearch } from "../utils";

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

const PAGE_SIZE = 40;

type Options = {
  filters: CatalogFilters;
  matchTab: "all" | MatchType;
  debounceMs?: number;
};

export function useCatalogSearch({ filters, matchTab, debounceMs = 280 }: Options) {
  const { branchId } = useAuth();
  const [data, setData] = useState<CatalogSearchResponse | null>(null);
  const [items, setItems] = useState<CatalogSearchItem[]>([]);
  const [facets, setFacets] = useState<CatalogFacets | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const matchTabRef = useRef(matchTab);
  matchTabRef.current = matchTab;
  const itemsLenRef = useRef(0);
  itemsLenRef.current = items.length;

  const runSearch = useCallback(
    async (next: CatalogFilters, tab: typeof matchTab, append = false) => {
      const q = next.q.trim();
      const hasFilters = hasBrowseFilters(next);

      if ((q.length > 0 && q.length < 2 && !hasFilters) || (!q && !hasFilters)) {
        abortRef.current?.abort();
        setData(null);
        setItems([]);
        setLoading(false);
        setLoadingMore(false);
        setError(null);
        return;
      }

      if (!append) abortRef.current?.abort();
      const ac = new AbortController();
      if (!append) abortRef.current = ac;
      const requestId = append ? requestIdRef.current : ++requestIdRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      const skip = append ? itemsLenRef.current : 0;

      try {
        const qs = buildSearchQuery(next, {
          skip,
          take: PAGE_SIZE,
          matchType: tab,
        });
        const result = await apiJson<CatalogSearchResponse>(`/catalog/search?${qs}`, {
          signal: append ? undefined : ac.signal,
        });
        if (!append && (requestId !== requestIdRef.current || ac.signal.aborted)) {
          return;
        }
        setData(result);
        setItems((prev) => (append ? [...prev, ...result.items] : result.items));
        if (q.length >= 2 && !append) pushRecentSearch(q);
      } catch (err) {
        if (
          isAbortError(err) ||
          (!append && (ac.signal.aborted || requestId !== requestIdRef.current))
        ) {
          return;
        }
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        if (append) setLoadingMore(false);
        else if (requestId === requestIdRef.current && !ac.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void runSearch(filters, matchTab, false);
    }, debounceMs);
    return () => window.clearTimeout(handle);
  }, [filters, matchTab, debounceMs, branchId, runSearch]);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (filters.dosageForm) params.set("dosageForm", filters.dosageForm);
        if (filters.brandName) params.set("brandName", filters.brandName);
        if (filters.controlled) params.set("isControlled", "true");
        if (filters.categoryId) params.set("categoryId", filters.categoryId);
        if (filters.tagId) params.set("tagId", filters.tagId);
        params.set("status", "active");
        const f = await apiJson<CatalogFacets>(`/catalog/facets?${params.toString()}`);
        if (!cancelled) setFacets(f);
      } catch {
        /* keep previous facets */
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [
    branchId,
    filters.dosageForm,
    filters.brandName,
    filters.controlled,
    filters.categoryId,
    filters.tagId,
  ]);

  const loadMore = useCallback(() => {
    void runSearch(filtersRef.current, matchTabRef.current, true);
  }, [runSearch]);

  const searchNow = useCallback(() => {
    void runSearch(filtersRef.current, matchTabRef.current, false);
  }, [runSearch]);

  return {
    data,
    items,
    facets,
    loading,
    loadingMore,
    error,
    reload: searchNow,
    loadMore,
    hasMore: Boolean(data?.hasMore),
    truncated: Boolean(data?.truncated),
    hasBranch: Boolean(branchId),
    pageSize: PAGE_SIZE,
  };
}
