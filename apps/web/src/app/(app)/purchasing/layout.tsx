"use client";

import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { PURCHASING_ROLES } from "@/lib/role-access";

export default function PurchasingLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={PURCHASING_ROLES} permissions={["purchasing.view"]}>
      {children}
    </RolePageGuard>
  );
}
