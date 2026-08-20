import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { OPERATIONS_ROLES } from "@/lib/role-access";

export default function TransfersLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={OPERATIONS_ROLES} permissions={["transfers.view"]}>
      {children}
    </RolePageGuard>
  );
}
