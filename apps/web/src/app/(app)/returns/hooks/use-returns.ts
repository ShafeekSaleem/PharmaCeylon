"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { ReturnListItem } from "../types";

export function useReturns() {
  const { branchId } = useAuth();
  const [rows, setRows] = useState<ReturnListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiJson<ReturnListItem[]>("/returns");
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load returns");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload, hasBranch: !!branchId };
}
