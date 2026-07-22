"use client";

import type { ReactNode } from "react";
import { RoleAccessDenied } from "./role-access-denied";
import { useRoleAccess } from "@/lib/use-role-access";
import { roleDeniedMessage, type RoleName } from "@/lib/role-access";

type Props = {
  roles?: RoleName[];
  title?: string;
  description?: string;
  children: ReactNode;
};

/** Blocks page content when the user lacks module access; shows a calm denied state (not an error alert). */
export function RolePageGuard({
  roles,
  title = "Insufficient permissions",
  description,
  children,
}: Props) {
  const { canAccess } = useRoleAccess();
  const allowed = canAccess(roles);

  if (allowed) return <>{children}</>;

  return (
    <RoleAccessDenied
      title={title}
      description={description ?? roleDeniedMessage(roles)}
    />
  );
}
