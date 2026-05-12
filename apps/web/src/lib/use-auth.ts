"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { loginRequest, logoutAllRequest, logoutRequest } from "./auth-client";
import type { AuthUser } from "./auth-types";
import {
  loadStoredSession,
  setBranchId as persistBranchId,
} from "./auth-session";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const fn = () => onChange();
  window.addEventListener("pharmaceylon-auth", fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener("pharmaceylon-auth", fn);
    window.removeEventListener("storage", fn);
  };
}

function getSnapshot() {
  return loadStoredSession();
}

function getServerSnapshot() {
  return {
    user: null as AuthUser | null,
    branchId: null as string | null,
  };
}

export function useAuth() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const login = useCallback(
    async (input: { tenantCode: string; email: string; password: string }) => {
      const user = await loginRequest(input);
      const first = user.branchRoles[0]?.branchId ?? null;
      persistBranchId(first);
    },
    [],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
  }, []);

  const logoutAll = useCallback(async () => {
    await logoutAllRequest();
  }, []);

  const setBranchId = useCallback((id: string | null) => {
    persistBranchId(id);
  }, []);

  return useMemo(
    () => ({
      user: s.user,
      /** Best-effort indicator. Source of truth is the server — any 401 clears this. */
      isAuthenticated: s.user !== null,
      branchId: s.branchId,
      /** True after client hydration (used to avoid SSR/client flash for redirects). */
      ready: typeof window !== "undefined",
      login,
      logout,
      logoutAll,
      setBranchId,
    }),
    [s.user, s.branchId, login, logout, logoutAll, setBranchId],
  );
}
