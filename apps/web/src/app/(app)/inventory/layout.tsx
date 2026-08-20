"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { RolePageGuard } from "@/components/role-access";
import { OPERATIONS_ROLES } from "@/lib/role-access";
import { InventorySubnav } from "./components/inventory-subnav";
import css from "./inventory.module.css";

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className={css.page}>
      <RolePageGuard roles={OPERATIONS_ROLES} permissions={["inventory.view"]}>
        <Suspense fallback={<div className={css.subnav} aria-hidden />}>
          <InventorySubnav />
        </Suspense>
        <div key={pathname} className={css.sectionContent}>
          {children}
        </div>
      </RolePageGuard>
    </div>
  );
}
