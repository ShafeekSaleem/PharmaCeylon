"use client";

import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { ADMIN_ROLES } from "@/lib/role-access";

export default function AuditLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={ADMIN_ROLES} permissions={["audit.view"]}>
      {children}
    </RolePageGuard>
  );
}
