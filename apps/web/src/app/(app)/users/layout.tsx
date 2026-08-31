"use client";

import { usePathname } from "next/navigation";
import { RolePageGuard } from "@/components/role-access";
import { ADMIN_ROLES } from "@/lib/role-access";
import { UsersSubnav } from "./components/users-subnav";
import css from "./users.module.css";

export default function UsersLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const permissions = pathname.startsWith("/users/roles")
    ? ["roles.manage"]
    : ["users.view"];

  return (
    <RolePageGuard roles={ADMIN_ROLES} permissions={permissions}>
      <div className={css.page}>
        <UsersSubnav />
        <div key={pathname} className={css.sectionContent}>
          {children}
        </div>
      </div>
    </RolePageGuard>
  );
}
