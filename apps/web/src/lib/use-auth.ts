"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fetchMe, loginRequest, logoutAllRequest, logoutRequest } from "./auth-client";
import type { AuthUser } from "./auth-types";
import {
  loadStoredSession,
  persistUser,
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

const SERVER_SNAPSHOT: { user: AuthUser | null; branchId: string | null } = {
  user: null,
  branchId: null,
};

function getServerSnapshot() {
  return SERVER_SNAPSHOT;
}

export function useAuth() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);

  const login = useCallback(
    async (input: { email: string; password: string }) => {
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

  const refreshUser = useCallback(async () => {
    const user = await fetchMe();
    persistUser(user);
    return user;
  }, []);

  return useMemo(
    () => ({
      user: s.user,
      isAuthenticated: s.user !== null,
      branchId: s.branchId,
      ready: hydrated,
      login,
      logout,
      logoutAll,
      setBranchId,
      refreshUser,
    }),
    [s.user, s.branchId, hydrated, login, logout, logoutAll, setBranchId, refreshUser],
  );
}
