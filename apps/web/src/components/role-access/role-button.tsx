"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { roleDeniedMessage, type RoleName } from "@/lib/role-access";
import { useRoleAccess } from "@/lib/use-role-access";
import { hasPermission, usePermissions } from "@/lib/permissions";
import styles from "./role-link.module.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  roles?: RoleName[];
  /**
   * Preferred over `roles` — checked against the caller's live, configurable
   * permission set, so a custom role granted this permission gets in even
   * though it's not one of the static `roles`. `roles` is still used for the
   * denied-message copy when both are given. See `RolePageGuard`.
   */
  permissions?: string[];
  deniedMessage?: string;
  children: ReactNode;
};

/** Button counterpart to `RoleLink`: disables + explains instead of navigating when the role check fails. */
export function RoleButton({
  roles,
  permissions,
  deniedMessage,
  className,
  children,
  disabled,
  ...rest
}: Props) {
  const { canAccess } = useRoleAccess();
  const { permissionKeys, loading, hasLoadedOnce } = usePermissions();
  // Avoid a denied flash before the first permission fetch resolves (see RolePageGuard).
  const allowed = permissions
    ? (loading && !hasLoadedOnce) || hasPermission(permissionKeys, permissions)
    : canAccess(roles);
  const deniedTip = deniedMessage ?? roleDeniedMessage(roles);

  if (!allowed) {
    const mergedClass = [className, styles.restricted].filter(Boolean).join(" ");
    return (
      <button
        type="button"
        className={mergedClass}
        disabled
        aria-disabled="true"
        data-tooltip={deniedTip}
        {...rest}
      >
        {children}
      </button>
    );
  }

  return (
    <button type="button" className={className} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
