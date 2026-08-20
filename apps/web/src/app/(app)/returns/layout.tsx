import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { RETURNS_ROLES } from "@/lib/role-access";

export default function ReturnsLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={RETURNS_ROLES} permissions={["returns.view"]}>
      {children}
    </RolePageGuard>
  );
}
