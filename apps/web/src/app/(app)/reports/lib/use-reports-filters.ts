"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import type { Scope } from "./types";
import { CATEGORIES, type CategoryKey, type ReportKey, defaultReportFor, resolveReportKeyAlias } from "./nav-config";

const SCOPE_KEY = "pharmaceylon.reports.scope";

function readStoredScope(): Scope {
  if (typeof window === "undefined") return "branch";
  return window.localStorage.getItem(SCOPE_KEY) === "tenant" ? "tenant" : "branch";
}

/**
 * Owns the two kinds of Reports filter state on purpose kept apart:
 * - category/report selection lives in the URL (`?category=&report=`) so it's linkable/back-button-able,
 *   mirroring the inventory subnav pattern but without spinning up a real route per report.
 * - branch scope is local UI state (persisted, not shareable) — same treatment the dashboard gives its
 *   owner branch-scope toggle.
 */
export function useReportsFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, branchId, setBranchId, ready } = useAuth();

  const isOwner = useMemo(() => (user?.branchRoles ?? []).some((br) => br.role === "owner"), [user]);

  const [scope, setScopeState] = useState<Scope>("branch");
  useEffect(() => setScopeState(readStoredScope()), []);
  const setScope = useCallback((next: Scope) => {
    setScopeState(next);
    if (typeof window !== "undefined") window.localStorage.setItem(SCOPE_KEY, next);
  }, []);
  // Non-owners can never get tenant-wide reports (the API silently ignores scope=tenant for them) — keep the UI honest.
  const effectiveScope: Scope = isOwner ? scope : "branch";

  const [branches, setBranches] = useState<TenantBranch[]>([]);
  useEffect(() => {
    if (!ready || !user) return;
    let cancelled = false;
    fetchTenantBranches()
      .then((b) => { if (!cancelled) setBranches(b); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ready, user]);

  const currentBranch = useMemo(() => branches.find((b) => b.id === branchId) ?? null, [branches, branchId]);

  const categoryParam = (searchParams.get("category") ?? "sales") as CategoryKey;
  const category = CATEGORIES.some((c) => c.key === categoryParam) ? categoryParam : "sales";
  const reportParam = searchParams.get("report") as ReportKey | null;
  const report: ReportKey = (reportParam ? resolveReportKeyAlias(reportParam) : null) ?? defaultReportFor(category) ?? "";

  const navigate = useCallback(
    (nextCategory: CategoryKey, nextReport?: ReportKey) => {
      const params = new URLSearchParams();
      params.set("category", nextCategory);
      const resolvedReport = nextReport ?? defaultReportFor(nextCategory);
      if (resolvedReport) params.set("report", resolvedReport);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname],
  );

  return {
    category,
    report,
    navigate,
    scope: effectiveScope,
    setScope,
    isOwner,
    branchId,
    setBranchId,
    branches,
    currentBranch,
    ready,
  };
}

export type ReportsFilters = ReturnType<typeof useReportsFilters>;
