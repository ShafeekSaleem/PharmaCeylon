"use client";

import { useEffect, useState } from "react";
import type { DailyWorkResponse, WorkCategory } from "@pharmaceylon/shared";
import { apiJson } from "./auth-client";

/**
 * Sidebar badges (UI1 #205): how many things in each area need someone's action at the selected
 * branch. The counts are the dashboard work queue's own per-area totals, so a badge and the
 * queue never disagree, and each work source already leaves out what the person may not do.
 *
 * Areas without a sidebar item get no badge: returns open on /returns, and counter work is done
 * in PharmaCeylon POS.
 */
export const NAV_BADGE_AREAS: Partial<Record<WorkCategory, string>> = {
  inventory: "/inventory",
  purchasing: "/purchasing",
  transfers: "/transfers",
  stocktakes: "/stocktakes",
};

const REFRESH_MS = 60_000;

/** Nav href → count of items needing action; a href with nothing waiting is left out. */
export function navBadgeCounts(
  categories: DailyWorkResponse["categories"] | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [area, href] of Object.entries(NAV_BADGE_AREAS)) {
    const n = categories?.[area as WorkCategory] ?? 0;
    if (href && n > 0) out[href] = n;
  }
  return out;
}

/** "3" up to 99, then "99+", so the badge stays one small pill. */
export function navBadgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function useNavBadges(
  branchId: string | null | undefined,
  enabled: boolean,
  pathname: string,
): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    };
    const interval = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !branchId) {
      setCounts({});
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ filter: "all", page: "1", pageSize: "1" });
    apiJson<DailyWorkResponse>(`/dashboard/work?${params}`, {
      signal: controller.signal,
      headers: { "x-branch-id": branchId },
    })
      .then((res) => {
        if (!controller.signal.aborted) setCounts(navBadgeCounts(res.categories));
      })
      .catch(() => {
        // A badge is a hint: on a failed read keep the last counts rather than flash them away.
      });
    return () => controller.abort();
  }, [branchId, enabled, pathname, tick]);

  return counts;
}
