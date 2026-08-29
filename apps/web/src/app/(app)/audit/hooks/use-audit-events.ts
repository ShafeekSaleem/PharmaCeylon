"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { PAGE_SIZE } from "../constants";
import type { AuditEventRow, AuditFilters } from "../types";
import { dateRangeToIso } from "../utils";

function buildQuery(filters: AuditFilters, page: number, branchId?: string | null): string {
  const params = new URLSearchParams();
  params.set("take", String(PAGE_SIZE));
  params.set("skip", String((page - 1) * PAGE_SIZE));
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.module !== "all") params.set("module", filters.module);
  if (filters.action !== "all") params.set("action", filters.action);
  if (filters.severity === "critical") params.set("severity", "critical");
  if (filters.branchScope === "branch" && branchId) params.set("branchId", branchId);
  if (filters.entityName) params.set("entityName", filters.entityName);
  if (filters.entityId) params.set("entityId", filters.entityId);
  const { from, to } = dateRangeToIso(filters.dateRange);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params.toString();
}

/**
 * `branchId` is the tenant's currently-selected branch (from the topbar switcher) — it's
 * only applied to the query when `filters.branchScope === "branch"`, so switching branches
 * live-updates results whenever that scope is active.
 */
export function useAuditEvents(filters: AuditFilters, page: number, branchId?: string | null) {
  const [items, setItems] = useState<AuditEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Filter/branch/page changes can each fire a new request before the previous one
  // resolves — without this, a slower stale response (e.g. the unfiltered request that
  // always fires first on mount) can land after a faster, more current one and silently
  // overwrite it with the wrong result set.
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const qs = buildQuery(filters, page, branchId);
      const res = await apiJson<{ items: AuditEventRow[]; total: number }>(
        `/audit/events?${qs}`,
      );
      if (requestId !== requestIdRef.current) return;
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load audit events");
      setItems([]);
      setTotal(0);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [
    filters.q,
    filters.module,
    filters.action,
    filters.severity,
    filters.dateRange,
    filters.branchScope,
    filters.entityName,
    filters.entityId,
    branchId,
    page,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, total, loading, error, reload };
}
