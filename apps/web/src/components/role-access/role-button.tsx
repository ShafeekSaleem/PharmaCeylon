"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { roleDeniedMessage, type RoleName } from "@/lib/role-access";
import { hasPermission, usePermissions } from "@/lib/permissions";
import { useRoleAccess } from "@/lib/use-role-access";
import styles from "./role-link.module.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  roles?: RoleName[];
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
  const { permissionKeys, hasLoadedOnce } = usePermissions();
  const allowed = permissions
    ? hasLoadedOnce && hasPermission(permissionKeys, permissions)
    : canAccess(roles);
  const deniedTip =
    deniedMessage ??
    (permissions ? "You don't have permission to perform this action." : roleDeniedMessage(roles));

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

