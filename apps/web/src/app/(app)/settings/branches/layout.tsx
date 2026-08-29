"use client";

import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { ADMIN_ROLES } from "@/lib/role-access";

export default function BranchesLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={ADMIN_ROLES} permissions={["tenant.branches_view"]}>
      {children}
    </RolePageGuard>
  );
}
