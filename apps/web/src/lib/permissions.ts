"use client";

import { useEffect, useState } from "react";
import { apiJson } from "./auth-client";
import { useAuth } from "./use-auth";

type MyPermissionsResponse = { permissionKeys: string[] };

async function fetchMyPermissions(): Promise<string[]> {
  const data = await apiJson<MyPermissionsResponse>("/tenant/my-permissions");
  return data.permissionKeys;
}

export function hasPermission(granted: string[], required?: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((key) => granted.includes(key));
}

/**
 * The current user's effective permission keys at the active branch.
 * Refetches whenever the selected branch changes (permissions are
 * branch-scoped, same as the API's guard). `owner` gets every key back
 * from the API directly — no separate bypass needed here.
 */
export function usePermissions() {
  const { user, branchId, ready } = useAuth();
  const [permissionKeys, setPermissionKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready || !user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchMyPermissions()
      .then((keys) => {
        if (!cancelled) setPermissionKeys(keys);
      })
      .catch(() => {
        if (!cancelled) setPermissionKeys([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, user, branchId]);

  return { permissionKeys, loading };
}
