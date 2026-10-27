"use client";

import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { SALES_ROLES } from "@/lib/role-access";

export default function SalesLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={SALES_ROLES} permissions={["sales.view"]}>
      {children}
    </RolePageGuard>
  );
}
