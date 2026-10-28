"use client";

import { useEffect, useState } from "react";
import { apiJson } from "./auth-client";
import { useAuth } from "./use-auth";

type MyPermissionsResponse = {
  permissionKeys: string[];
  canSelfApprove?: boolean;
  backOfficeAccess?: boolean;
};
type Granted = {
  keys: string[];
  canSelfApprove: boolean;
  backOfficeAccess: boolean;
  accessResolved: boolean;
};

async function fetchMyPermissions(): Promise<Granted> {
  const data = await apiJson<MyPermissionsResponse>("/tenant/my-permissions");
  return {
    keys: data.permissionKeys,
    canSelfApprove: data.canSelfApprove ?? false,
    backOfficeAccess: data.backOfficeAccess === true,
    accessResolved: true,
  };
}

export function hasPermission(granted: string[], required?: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((key) => granted.includes(key));
}

/**
 * One shared answer per branch, so the several components that ask on a page make one request
 * between them, and a revalidation reaches all of them at once.
 */
const subscribers = new Set<{
  branchKey: string;
  notify: (granted: Granted) => void;
}>();
let cache: { branchKey: string; granted: Granted } | null = null;
let inFlight: { branchKey: string; promise: Promise<Granted> } | null = null;

/** Test seam, matching the branch rollout cache. */
export function resetPermissionsCache(): void {
  cache = null;
  inFlight = null;
}

function load(branchKey: string, force = false): Promise<Granted> {
  if (!force && cache?.branchKey === branchKey) return Promise.resolve(cache.granted);
  if (inFlight?.branchKey === branchKey && !force) return inFlight.promise;
  const promise = fetchMyPermissions()
    .then((granted) => {
      cache = { branchKey, granted };
      for (const subscriber of subscribers)
        if (subscriber.branchKey === branchKey) subscriber.notify(granted);
      return granted;
    })
    .catch(() => {
      cache = null;
      const denied = {
        keys: [],
        canSelfApprove: false,
        backOfficeAccess: false,
        accessResolved: false,
      };
      for (const subscriber of subscribers)
        if (subscriber.branchKey === branchKey) subscriber.notify(denied);
      return denied;
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
  const [canSelfApprove, setCanSelfApprove] = useState(
    () => cache?.granted.canSelfApprove ?? false,
  );
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);
  const [accessResolved, setAccessResolved] = useState(false);
  const [backOfficeAccess, setBackOfficeAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  useEffect(() => {
    if (!ready || !user) {
      setLoading(false);
      return;
    }
    const branchKey = `${user.id}:${branchId ?? "none"}`;
    let cancelled = false;
    setLoading(true);

    const notify = (granted: Granted) => {
      if (cancelled) return;
      setPermissionKeys(granted.keys);
      setCanSelfApprove(granted.canSelfApprove);
      setBackOfficeAccess(granted.backOfficeAccess);
      setAccessResolved(granted.accessResolved);
      setResolvedKey(branchKey);
    };
    const subscriber = { branchKey, notify };
    subscribers.add(subscriber);

    const settle = (granted: Granted) => {
      if (cancelled) return;
      notify(granted);
      setLoading(false);
      setHasLoadedOnce(true);
    };
    load(branchKey)
      .then(settle)
      .catch(() =>
        settle({
          keys: [],
          canSelfApprove: false,
          backOfficeAccess: false,
          accessResolved: false,
        }),
      );

    // A permission someone else changed should take effect when this tab is looked at again,
    // not only after a full reload.
    const revalidate = () => {
      if (document.visibilityState === "visible")
        void load(branchKey, true).catch(() =>
          notify({
            keys: [],
            canSelfApprove: false,
            backOfficeAccess: false,
            accessResolved: false,
          }),
        );
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);

    return () => {
      cancelled = true;
      subscribers.delete(subscriber);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [ready, user, branchId]);

  const scopeMatches = resolvedKey === `${user?.id}:${branchId ?? "none"}`;
  return {
    permissionKeys,
    canSelfApprove,
    backOfficeAccess: scopeMatches && backOfficeAccess,
    accessResolved: scopeMatches && accessResolved,
    loading: loading || !scopeMatches,
    hasLoadedOnce,
  };
}
