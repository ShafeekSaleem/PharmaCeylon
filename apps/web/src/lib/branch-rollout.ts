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

/**
 * The latest answer for a user. `current` is a successful read; `failed` means the latest read —
 * the first one or a forced refresh — did not land, so no earlier answer may stand in for it.
 */
type RolloutAnswer =
  | { userKey: string; status: "current"; rollouts: Rollouts }
  | { userKey: string; status: "failed" };

/** One shared answer per signed-in user, like `usePermissions`: the context covers every branch. */
const subscribers = new Set<(answer: RolloutAnswer) => void>();
let cache: { userKey: string; rollouts: Rollouts } | null = null;
let inFlight: { userKey: string; promise: Promise<Rollouts> } | null = null;
// Only the newest read may settle the shared answer, so a slow older success cannot land after
// a newer failure (or the other way round).
let generation = 0;

function publish(answer: RolloutAnswer): void {
  for (const notify of subscribers) notify(answer);
}

function load(userKey: string, force = false): Promise<Rollouts> {
  if (!force && cache?.userKey === userKey) return Promise.resolve(cache.rollouts);
  if (!force && inFlight?.userKey === userKey) return inFlight.promise;
  const mine = ++generation;
  const promise = fetchRollouts()
    .then(
      (rollouts) => {
        if (mine === generation) {
          cache = { userKey, rollouts };
          publish({ userKey, status: "current", rollouts });
        }
        return rollouts;
      },
      (error: unknown) => {
        // Fail closed: a refresh that didn't land must not leave an earlier state (a `not_live`
        // that opens every web page, say) standing in for the branch's current one.
        if (mine === generation) {
          cache = null;
          publish({ userKey, status: "failed" });
        }
        throw error;
      },
    )
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
  generation++;
}

// setTimeout's longest delay; a fallback lasts at most a week, so this is only a guard.
const MAX_TIMER_MS = 2_147_483_647;

export type BranchRolloutResult = {
  /** The branch's state, or `null` while it is unknown: loading, failed, or not described. */
  rollout: PosRollout | null;
  /** The first read for this user hasn't settled yet. */
  loading: boolean;
  /** `rollout` comes from a successful read of the signed-in user's context. */
  resolved: boolean;
  /** The latest read failed; `rollout` stays `null` until a later read succeeds. */
  failed: boolean;
};

/**
 * The selected branch's desktop POS rollout state, or `null` until it is known.
 *
 * Callers read `null` as "scope unknown" and fail closed. Reads again when the tab is looked at,
 * when branches change, and when the switch is changed here; flips from fallback to live on its
 * own when the fallback runs out. A refresh in flight keeps the previous answer, but one that
 * fails clears it (`failed`), so an earlier `not_live` can't keep the back office open after the
 * branch went live.
 */
export function useBranchRollout(): BranchRolloutResult {
  const { user, branchId, ready } = useAuth();
  const userKey = user?.id ?? null;
  const [answer, setAnswer] = useState<RolloutAnswer | null>(() =>
    cache && cache.userKey === userKey
      ? { userKey: cache.userKey, status: "current", rollouts: cache.rollouts }
      : null,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ready || !userKey) return;
    let cancelled = false;
    const notify = (next: RolloutAnswer) => {
      if (!cancelled && next.userKey === userKey) setAnswer(next);
    };
    subscribers.add(notify);
    if (cache?.userKey === userKey) {
      notify({ userKey, status: "current", rollouts: cache.rollouts });
    } else {
      // Settles through `notify`, success or failure.
      void load(userKey).catch(() => {});
    }

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

  const mine = userKey !== null && answer?.userKey === userKey ? answer : null;
  const resolved = mine?.status === "current";
  const failed = mine?.status === "failed";
  const stored = mine?.status === "current" && branchId ? (mine.rollouts[branchId] ?? null) : null;
  const endsAt = stored?.state === "fallback" ? stored.fallback?.endsAt : undefined;

  // Wake up when the running fallback ends, so the banner goes and POS hides without a reload.
  useEffect(() => {
    if (!endsAt) return;
    const remaining = new Date(endsAt).getTime() - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(remaining + 50, MAX_TIMER_MS));
    return () => window.clearTimeout(timer);
  }, [endsAt]);

  return {
    rollout: currentRollout(stored, now),
    loading: ready && userKey !== null && !resolved && !failed,
    resolved,
    failed,
  };
}
