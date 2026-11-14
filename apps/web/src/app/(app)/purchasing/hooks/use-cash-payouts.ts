"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupplierCashPayoutView } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";

function qs(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function useCashPayouts(
  query: { supplierId?: string; status?: string } = {},
  enabled = true,
) {
  const { branchId, user } = useAuth();
  const identity = `${user?.tenantId}:${user?.id}:${branchId}`;
  const path = branchId && enabled ? `/purchasing/cash-payouts${qs(query)}` : null;
  const key = `${identity}:${path}`;
  const [rows, setRows] = useState<SupplierCashPayoutView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; fetched: boolean } | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    if (!path) {
      setRows([]);
      setError(null);
      setPermissionDenied(false);
      setLoaded({ key, fetched: false });
      return;
    }
    setError(null);
    setPermissionDenied(false);
    try {
      const next = await apiJson<SupplierCashPayoutView[]>(path);
      if (mine !== generation.current) return;
      setRows(next);
    } catch (err) {
      if (mine !== generation.current) return;
      const message = err instanceof Error ? err.message : "Cash payouts could not be loaded.";
      if (message.includes("authorize supplier payments")) {
        setPermissionDenied(true);
        setRows([]);
      } else {
        setError(message);
        setRows([]);
      }
    }
    setLoaded({ key, fetched: true });
  }, [path, key]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return {
    rows: loaded?.key === key ? rows : [],
    error: loaded?.key === key ? error : null,
    permissionDenied: loaded?.key === key ? permissionDenied : false,
    loading: !loaded || loaded.key !== key || !loaded.fetched,
    fresh: loaded?.key === key && loaded.fetched,
    reload,
  };
}

export async function fetchCashPayout(id: string): Promise<SupplierCashPayoutView> {
  return apiJson<SupplierCashPayoutView>(`/purchasing/cash-payouts/${id}`);
}