"use client";

import Link from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { roleDeniedMessage, rolesForHref, type RoleName } from "@/lib/role-access";
import { useRoleAccess } from "@/lib/use-role-access";
import styles from "./role-link.module.css";

type Props = Omit<AnchorHTMLAttributes<HTMLSpanElement>, "href"> & {
  href: string;
  roles?: RoleName[];
  deniedMessage?: string;
  children: ReactNode;
};

export function RoleLink({
  href,
  roles,
  deniedMessage,
  className,
  children,
  onClick,
  ...rest
}: Props) {
  const { canAccess } = useRoleAccess();
  const required = roles ?? rolesForHref(href);
  const allowed = canAccess(required);
  const tooltip = deniedMessage ?? roleDeniedMessage(required);

  if (allowed) {
    return (
      <Link href={href} className={className} onClick={onClick}>
        {children}
      </Link>
    );
  }

  const mergedClass = [className, styles.restricted].filter(Boolean).join(" ");

  return (
    <span
      role="link"
      aria-disabled="true"
      className={mergedClass}
      data-tooltip={tooltip}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
