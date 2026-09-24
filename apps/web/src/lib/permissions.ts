"use client";

import { useEffect, useState } from "react";
import { apiJson } from "./auth-client";
import { useAuth } from "./use-auth";

type MyPermissionsResponse = { permissionKeys: string[]; canSelfApprove?: boolean };
type Granted = { keys: string[]; canSelfApprove: boolean };

async function fetchMyPermissions(): Promise<Granted> {
  const data = await apiJson<MyPermissionsResponse>("/tenant/my-permissions");
  return { keys: data.permissionKeys, canSelfApprove: data.canSelfApprove ?? false };
}

export function hasPermission(granted: string[], required?: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((key) => granted.includes(key));
}

/**
 * One shared answer per branch, so the several components that ask on a page make one request
 * between them, and a revalidation reaches all of them at once.
 */
const subscribers = new Set<(granted: Granted) => void>();
let cache: { branchKey: string; granted: Granted } | null = null;
let inFlight: { branchKey: string; promise: Promise<Granted> } | null = null;

function load(branchKey: string, force = false): Promise<Granted> {
  if (!force && cache?.branchKey === branchKey) return Promise.resolve(cache.granted);
  if (inFlight?.branchKey === branchKey && !force) return inFlight.promise;
  const promise = fetchMyPermissions()
    .then((granted) => {
      cache = { branchKey, granted };
      for (const notify of subscribers) notify(granted);
      return granted;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { branchKey, promise };
  return promise;
}

/**
 * The current user's effective permission keys at the active branch.
 *
 * Refetches whenever the selected branch changes (permissions are branch-scoped, same as the
 * API's guard) and whenever the tab is focused again. That last one matters because an owner
 * granting or removing a permission is a change to *someone else's* open session: without it,
 * the change only lands when that person happens to remount a page, which reads as the grant
 * not working. `owner` gets every key back from the API directly — no separate bypass here.
 *
 * `hasLoadedOnce` lets a caller like `RolePageGuard` distinguish the very first fetch (nothing
 * to show yet) from a later refetch (keep rendering the page with the previous grant while it
 * revalidates) — without it, every branch switch would briefly unmount and remount the whole
 * page, discarding any local UI state (filters, search text, open modals, ...).
 */
export function usePermissions() {
  const { user, branchId, ready } = useAuth();
  const [permissionKeys, setPermissionKeys] = useState<string[]>(() => cache?.granted.keys ?? []);
  const [canSelfApprove, setCanSelfApprove] = useState(() => cache?.granted.canSelfApprove ?? false);
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  useEffect(() => {
    if (!ready || !user) {
      setLoading(false);
      return;
    }
    const branchKey = branchId ?? "none";
    let cancelled = false;
    setLoading(true);

    const notify = (granted: Granted) => {
      if (cancelled) return;
      setPermissionKeys(granted.keys);
      setCanSelfApprove(granted.canSelfApprove);
    };
    subscribers.add(notify);

    const settle = (granted: Granted) => {
      if (cancelled) return;
      notify(granted);
      setLoading(false);
      setHasLoadedOnce(true);
    };
    load(branchKey)
      .then(settle)
      .catch(() => settle({ keys: [], canSelfApprove: false }));

    // A permission someone else changed should take effect when this tab is looked at again,
    // not only after a full reload.
    const revalidate = () => {
      if (document.visibilityState === "visible") void load(branchKey, true).catch(() => {});
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);

    return () => {
      cancelled = true;
      subscribers.delete(notify);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [ready, user, branchId]);

  return { permissionKeys, canSelfApprove, loading, hasLoadedOnce };
}
