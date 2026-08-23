"use client";

import { useEffect, useState } from "react";
import { fetchProfitabilityTarget } from "./fetchers";

// Module-level, not per-hook-instance — every Profitability page (Profit Summary, Product/Category/
// Branch Profitability) needs this same tenant-wide value, and it changes rarely (an owner/manager
// editing it in Settings), so there's no reason for each page to issue its own GET on every mount.
// `undefined` = never fetched yet, distinct from `null` (fetched, no target configured).
let cachedTarget: number | null | undefined;
let inflight: Promise<number | null> | null = null;

/** Settings → Profitability edits this value through a fully independent code path (its own
 *  `api.ts`, not this file) — call this right after a successful save so a tab already open on a
 *  Profitability report picks up the new target instead of serving the stale cached one for the
 *  rest of the session. */
export function invalidateProfitabilityTargetCache() {
  cachedTarget = undefined;
  inflight = null;
}

function loadTarget(): Promise<number | null> {
  if (cachedTarget !== undefined) return Promise.resolve(cachedTarget);
  if (!inflight) {
    inflight = fetchProfitabilityTarget()
      .then((res) => {
        cachedTarget = res.targetGrossMarginPercent;
        return cachedTarget;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Same `{ targetPct, targetLoaded }` shape every consumer already used with its own independent
 *  `fetchProfitabilityTarget()` call — this just shares one fetch/cache across all of them. */
export function useProfitabilityTarget() {
  const [targetPct, setTargetPct] = useState<number | null>(cachedTarget ?? null);
  const [targetLoaded, setTargetLoaded] = useState(cachedTarget !== undefined);

  useEffect(() => {
    let cancelled = false;
    loadTarget()
      .then((v) => {
        if (!cancelled) setTargetPct(v);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTargetLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { targetPct, targetLoaded };
}
