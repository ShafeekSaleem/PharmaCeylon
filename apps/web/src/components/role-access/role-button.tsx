"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { roleDeniedMessage, type RoleName } from "@/lib/role-access";
import { useRoleAccess } from "@/lib/use-role-access";
import styles from "./role-link.module.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  roles?: RoleName[];
  deniedMessage?: string;
  children: ReactNode;
};

/** Button counterpart to `RoleLink`: disables + explains instead of navigating when the role check fails. */
export function RoleButton({
  roles,
  deniedMessage,
  className,
  children,
  disabled,
  ...rest
}: Props) {
  const { canAccess } = useRoleAccess();
  const allowed = canAccess(roles);
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
