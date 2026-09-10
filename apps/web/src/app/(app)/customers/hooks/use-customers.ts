"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import {
  PAGE_SIZE,
  type CustomerListItem,
  type CustomerListResponse,
  type CustomerProfile,
} from "../types";

export function useCustomersList(filters: {
  q: string;
  status: string;
  page: number;
}) {
  const [rows, setRows] = useState<CustomerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.status !== "all") params.set("status", filters.status);
      params.set("page", String(filters.page));
      params.set("pageSize", String(PAGE_SIZE));
      const res = await apiJson<CustomerListResponse>(
        `/customers/directory?${params.toString()}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load customers");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filters.q, filters.status, filters.page]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, total, loading, error, reload };
}

/** Loads the profile behind the detail drawer. `null` id means nothing is open. */
export function useCustomerProfile(customerId: string | null) {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!customerId) {
      setProfile(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setProfile(await apiJson<CustomerProfile>(`/customers/${customerId}/profile`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load customer");
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { profile, loading, error, reload };
}
