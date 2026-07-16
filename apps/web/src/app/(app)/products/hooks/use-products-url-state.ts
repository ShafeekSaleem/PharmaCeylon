"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SortDir } from "@/components/ui";
import {
  EMPTY_PRODUCT_FILTERS,
  type ProductFilters,
} from "../products-filter-panel";

function parseList(value: string | null): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

function parseFilters(params: URLSearchParams): ProductFilters {
  const status = parseList(params.get("status")) as ("active" | "inactive")[];
  const controlled = parseList(params.get("controlled")) as ("true" | "false")[];
  return {
    dosageForms: parseList(params.get("dosageForm")),
    brands: parseList(params.get("brand")),
    categories: parseList(params.get("categoryId")),
    tags: parseList(params.get("tagId")),
    status: status.filter((s) => s === "active" || s === "inactive"),
    controlled: controlled.filter((c) => c === "true" || c === "false"),
    lowStock: params.get("lowStock") === "1",
  };
}

function filtersToParams(filters: ProductFilters, base: URLSearchParams) {
  base.delete("dosageForm");
  base.delete("brand");
  base.delete("categoryId");
  base.delete("tagId");
  base.delete("status");
  base.delete("controlled");
  base.delete("lowStock");
  if (filters.dosageForms.length) base.set("dosageForm", filters.dosageForms.join(","));
  if (filters.brands.length) base.set("brand", filters.brands.join(","));
  if (filters.categories.length) base.set("categoryId", filters.categories.join(","));
  if (filters.tags.length) base.set("tagId", filters.tags.join(","));
  if (filters.status.length) base.set("status", filters.status.join(","));
  if (filters.controlled.length) base.set("controlled", filters.controlled.join(","));
  if (filters.lowStock) base.set("lowStock", "1");
}

export function useProductsUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const q = searchParams.get("q") ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const sortBy = searchParams.get("sortBy") ?? "name";
  const sortDir = (searchParams.get("sortDir") === "desc" ? "desc" : "asc") as SortDir;
  const appliedFilters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams.toString());
      mutate(next);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const setQ = useCallback(
    (value: string) => {
      replaceParams((p) => {
        if (value.trim()) p.set("q", value.trim());
        else p.delete("q");
        p.delete("page");
      });
    },
    [replaceParams],
  );

  const setPage = useCallback(
    (value: number) => {
      replaceParams((p) => {
        if (value <= 1) p.delete("page");
        else p.set("page", String(value));
      });
    },
    [replaceParams],
  );

  const setSort = useCallback(
    (key: string, dir: SortDir) => {
      replaceParams((p) => {
        p.set("sortBy", key);
        p.set("sortDir", dir);
        p.delete("page");
      });
    },
    [replaceParams],
  );

  const setFilters = useCallback(
    (filters: ProductFilters) => {
      replaceParams((p) => {
        filtersToParams(filters, p);
        p.delete("page");
      });
    },
    [replaceParams],
  );

  const clearFilters = useCallback(() => {
    replaceParams((p) => {
      filtersToParams(EMPTY_PRODUCT_FILTERS, p);
      p.delete("page");
    });
  }, [replaceParams]);

  return {
    q,
    page,
    sortBy,
    sortDir,
    appliedFilters,
    setQ,
    setPage,
    setSort,
    setFilters,
    clearFilters,
    listQueryString: searchParams.toString(),
  };
}
