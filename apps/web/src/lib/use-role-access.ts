"use client";

import { useMemo } from "react";
import { useAuth } from "./use-auth";
import {
  collectUserRoles,
  hasRoleAccess,
  type RoleName,
} from "./role-access";

export function useRoleAccess() {
  const { user } = useAuth();

  const userRoles = useMemo(() => collectUserRoles(user), [user]);

  const canAccess = useMemo(
    () => (allowedRoles?: RoleName[]) => hasRoleAccess(userRoles, allowedRoles),
    [userRoles],
  );

  return { user, userRoles, canAccess };
}
