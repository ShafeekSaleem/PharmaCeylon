"use client";

import { useMemo } from "react";
import { useAuth } from "./use-auth";
import {
  collectUserRoles,
  hasRoleAccess,
  type RoleName,
} from "./role-access";

export function useRoleAccess() {
  const { user, branchId } = useAuth();

  const userRoles = useMemo(() => collectUserRoles(user, branchId), [user, branchId]);

  const canAccess = useMemo(
    () => (allowedRoles?: RoleName[]) => hasRoleAccess(userRoles, allowedRoles),
    [userRoles],
  );

  return { user, userRoles, canAccess };
}
