"use client";

import { useEffect, useRef, useState } from "react";
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

/**
 * Each read runs the whole work-queue query, so a page change, focus or tab switch within this
 * long of the last read for the same branch reuses it. `focus` and `visibilitychange` usually fire
 * together on a tab switch; this makes them one request. A branch change always reads.
 */
export const NAV_BADGE_MIN_GAP_MS = 10_000;

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
  // Counts remember the branch they came from; another branch's are never shown, so a switch
  // clears the badges at once and a failed first read can't leave the old branch's numbers up.
  const [state, setState] = useState<{
    branchId: string | null;
    counts: Record<string, number>;
  }>({ branchId: null, counts: {} });
  const [tick, setTick] = useState(0);
  const last = useRef<{ branchId: string; at: number } | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
      last.current = null;
      return;
    }
    const prev = last.current;
    if (
      prev &&
      prev.branchId === branchId &&
      Date.now() - prev.at < NAV_BADGE_MIN_GAP_MS
    )
      return;
    last.current = { branchId, at: Date.now() };
    const id = ++seq.current;
    const params = new URLSearchParams({
      filter: "all",
      page: "1",
      pageSize: "1",
    });
    // Not aborted when a later refresh is skipped: that refresh relies on this read landing.
    apiJson<DailyWorkResponse>(`/dashboard/work?${params}`, {
      headers: { "x-branch-id": branchId },
    })
      .then((res) => {
        if (mounted.current && id === seq.current)
          setState({ branchId, counts: navBadgeCounts(res.categories) });
      })
      .catch(() => {
        // A failed refresh keeps the last counts for this branch; a failed first read for a
        // branch shows none, because the counts held belong to another branch.
        if (mounted.current && id === seq.current) last.current = null;
      });
  }, [branchId, enabled, pathname, tick]);

  return enabled && branchId && state.branchId === branchId ? state.counts : {};
}
