"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DailyWorkResponse,
  WorkCategory,
  WorkFilter,
} from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";

export function useDailyWork(
  branchId: string | null,
  refreshKey: string | null,
  initialFilter: WorkFilter = "all",
) {
  const [filter, setFilter] = useState<WorkFilter>(initialFilter);
  const [category, setCategory] = useState<WorkCategory | "">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DailyWorkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const reload = useCallback(() => setRetry((n) => n + 1), []);

  useEffect(() => {
    let lastRefresh = Date.now();
    const refresh = () => {
      if (
        document.visibilityState !== "visible" ||
        Date.now() - lastRefresh < 5_000
      )
        return;
      lastRefresh = Date.now();
      reload();
    };
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    const id = ++sequence.current;
    const active = () => id === sequence.current && !controller.signal.aborted;
    if (!branchId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ filter, page: String(page) });
    if (category) params.set("category", category);
    void apiJson<DailyWorkResponse>(`/dashboard/work?${params}`, {
      signal: controller.signal,
      headers: { "x-branch-id": branchId },
    })
      .then((result) => {
        if (!active()) return;
        // Completing the final task on a page must not leave the user on an empty page.
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setData(result);
      })
      .catch((err: unknown) => {
        if (active())
          setError(
            err instanceof Error
              ? err.message
              : "Couldn't load your work queue.",
          );
      })
      .finally(() => {
        if (active()) setLoading(false);
      });
    return () => controller.abort();
  }, [branchId, filter, category, page, retry, refreshKey]);

  return {
    data,
    loading,
    error,
    page,
    filter,
    category,
    reload,
    setPage,
    selectFilter: (value: WorkFilter) => {
      setFilter(value);
      setPage(1);
      setData(null);
    },
    selectCategory: (value: WorkCategory | "") => {
      setCategory(value);
      setPage(1);
      setData(null);
    },
  };
}
