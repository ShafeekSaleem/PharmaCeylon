"use client";

import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { ADMIN_ROLES } from "@/lib/role-access";

export default function MainSettingsLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={ADMIN_ROLES} permissions={["tenant.management"]}>
      {children}
    </RolePageGuard>
  );
}
