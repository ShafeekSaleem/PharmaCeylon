"use client";

import { usePathname } from "next/navigation";
import { RolePageGuard } from "@/components/role-access";
import { OPERATIONS_ROLES } from "@/lib/role-access";
import css from "./inventory.module.css";

export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className={css.page}>
      <RolePageGuard roles={OPERATIONS_ROLES} permissions={["inventory.view"]}>
        {/* The section nav is rendered by each page, immediately below its own description,
            so this section reads in the same order as Products: description, tabs, tiles. */}
        <div key={pathname} className={css.sectionContent}>
          {children}
        </div>
      </RolePageGuard>
    </div>
  );
}
