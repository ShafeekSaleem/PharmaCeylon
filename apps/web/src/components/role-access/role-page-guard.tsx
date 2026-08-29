"use client";

import type { ReactNode } from "react";
import { RoleAccessDenied } from "./role-access-denied";
import { useRoleAccess } from "@/lib/use-role-access";
import { roleDeniedMessage, type RoleName } from "@/lib/role-access";
import { hasPermission, usePermissions } from "@/lib/permissions";

type Props = {
  roles?: RoleName[];
  /**
   * Preferred over `roles` — checked against the caller's live, configurable
   * permission set (see `/tenant/my-permissions`), so a custom role granted
   * this permission gets in even though it's not one of the static `roles`.
   * When both are omitted, access is unrestricted.
   */
  permissions?: string[];
  title?: string;
  description?: string;
  children: ReactNode;
};

/** Blocks page content when the user lacks module access; shows a calm denied state (not an error alert). */
export function RolePageGuard({
  roles,
  permissions,
  title = "Insufficient permissions",
  description,
  children,
}: Props) {
  const { canAccess } = useRoleAccess();
  const { permissionKeys, loading, hasLoadedOnce } = usePermissions();

  if (permissions) {
    // Avoid a denied flash before the first permission fetch resolves. A later
    // refetch (e.g. triggered by switching branches) keeps showing the page with
    // the previous grant instead of unmounting it — unmounting would discard any
    // local UI state (filters, search text, open modals) on every branch switch.
    if (loading && !hasLoadedOnce) return null;
    if (!hasPermission(permissionKeys, permissions)) {
      return <RoleAccessDenied title={title} description={description ?? roleDeniedMessage(roles)} />;
    }
    return <>{children}</>;
  }

  if (canAccess(roles)) return <>{children}</>;

  return (
    <RoleAccessDenied
      title={title}
      description={description ?? roleDeniedMessage(roles)}
    />
  );
}
