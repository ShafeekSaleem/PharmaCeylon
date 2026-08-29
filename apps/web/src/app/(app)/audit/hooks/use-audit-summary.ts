"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import type { AuditSummary } from "../types";

export function useAuditSummary(branchId?: string | null) {
  const [data, setData] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const qs = branchId ? `?branchId=${branchId}` : "";
      const res = await apiJson<AuditSummary>(`/audit/summary${qs}`);
      if (requestId !== requestIdRef.current) return;
      setData(res);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load audit summary");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
