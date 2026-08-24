"use client";

import { RolePageGuard } from "@/components/role-access";
import { INSIGHTS_ROLES } from "@/lib/role-access";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <RolePageGuard roles={INSIGHTS_ROLES} permissions={["reports.view"]}>
      {children}
    </RolePageGuard>
  );
}
