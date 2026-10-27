"use client";

import { useEffect, useState } from "react";
import { apiJson, BRANCHES_CHANGED_EVENT } from "./auth-client";
import { useAuth } from "./use-auth";

/**
 * A branch's desktop POS switch (D-W1), as `GET /tenant/context` returns it with each branch.
 *
 * - `not_live`: the branch still sells from the web POS; the web behaves exactly as before.
 * - `live`: checkout has moved to PharmaCeylon POS on the branch's counters; the web hides POS.
 * - `fallback`: a live branch whose owner turned the web POS back on until `fallback.endsAt`.
 */
export type PosRolloutState = "not_live" | "live" | "fallback";

export type PosRollout = {
  state: PosRolloutState;
  liveSince: string | null;
  fallback: { startedAt: string; endsAt: string } | null;
};

type TenantContextResponse = {
  branchRoles?: Array<{ branchId: string; branch?: { posRollout?: PosRollout } }>;
};

/** Fired after an owner changes a branch's switch, so every open shell reads it again. */
export const POS_ROLLOUT_CHANGED_EVENT = "pharmaceylon-pos-rollout-changed";

export function notifyPosRolloutChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(POS_ROLLOUT_CHANGED_EVENT));
}

/** A fallback ends on its own at the time the owner set — including in a tab left open. */
export function currentRollout(rollout: PosRollout | null, now: number = Date.now()): PosRollout | null {
  if (rollout?.state !== "fallback" || !rollout.fallback) return rollout;
  if (new Date(rollout.fallback.endsAt).getTime() > now) return rollout;
  return { state: "live", liveSince: rollout.liveSince, fallback: null };
}

/** Whether the web POS is hidden at this branch: live, with no fallback running. */
export function webPosHidden(rollout: PosRollout | null): boolean {
  return rollout?.state === "live";
}

type Rollouts = Record<string, PosRollout>;

async function fetchRollouts(): Promise<Rollouts> {
  const context = await apiJson<TenantContextResponse>("/tenant/context");
  const rollouts: Rollouts = {};
  for (const entry of context.branchRoles ?? []) {
    const rollout = entry.branch?.posRollout;
    if (rollout) rollouts[entry.branchId] = rollout;
  }
  return rollouts;
}

/** One shared answer per signed-in user, like `usePermissions`: the context covers every branch. */
const subscribers = new Set<(rollouts: Rollouts) => void>();
let cache: { userKey: string; rollouts: Rollouts } | null = null;
let inFlight: { userKey: string; promise: Promise<Rollouts> } | null = null;

function load(userKey: string, force = false): Promise<Rollouts> {
  if (!force && cache?.userKey === userKey) return Promise.resolve(cache.rollouts);
  if (!force && inFlight?.userKey === userKey) return inFlight.promise;
  const promise = fetchRollouts()
    .then((rollouts) => {
      cache = { userKey, rollouts };
      for (const notify of subscribers) notify(rollouts);
      return rollouts;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { userKey, promise };
  return promise;
}

/** Test seam: forget the shared answer between specs. */
export function resetBranchRolloutCache(): void {
  cache = null;
  inFlight = null;
}

// setTimeout's longest delay; a fallback lasts at most a week, so this is only a guard.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The selected branch's desktop POS rollout state, or `null` until it is known.
 *
 * `null` reads as not live everywhere, so a branch that isn't live — and any branch while the
 * first answer is still loading — keeps today's web exactly. Reads again when the tab is looked
 * at, when branches change, and when the switch is changed here; flips from fallback to live on
 * its own when the fallback runs out.
 */
export function useBranchRollout(): { rollout: PosRollout | null; loading: boolean } {
  const { user, branchId, ready } = useAuth();
  const userKey = user?.id ?? null;
  const [rollouts, setRollouts] = useState<Rollouts>(() =>
    cache && cache.userKey === userKey ? cache.rollouts : {},
  );
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ready || !userKey) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const notify = (next: Rollouts) => {
      if (!cancelled) setRollouts(next);
    };
    subscribers.add(notify);
    setLoading(true);
    load(userKey)
      .then(notify)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const revalidate = () => {
      if (document.visibilityState === "visible") void load(userKey, true).catch(() => {});
    };
    const reload = () => void load(userKey, true).catch(() => {});
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener(BRANCHES_CHANGED_EVENT, reload);
    window.addEventListener(POS_ROLLOUT_CHANGED_EVENT, reload);
    return () => {
      cancelled = true;
      subscribers.delete(notify);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener(BRANCHES_CHANGED_EVENT, reload);
      window.removeEventListener(POS_ROLLOUT_CHANGED_EVENT, reload);
    };
  }, [ready, userKey]);

  const stored = branchId ? (rollouts[branchId] ?? null) : null;
  const endsAt = stored?.state === "fallback" ? stored.fallback?.endsAt : undefined;

  // Wake up when the running fallback ends, so the banner goes and POS hides without a reload.
  useEffect(() => {
    if (!endsAt) return;
    const remaining = new Date(endsAt).getTime() - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(remaining + 50, MAX_TIMER_MS));
    return () => window.clearTimeout(timer);
  }, [endsAt]);

  return { rollout: currentRollout(stored, now), loading };
}
