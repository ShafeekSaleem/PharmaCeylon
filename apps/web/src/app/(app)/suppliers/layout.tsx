import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { OPERATIONS_ROLES } from "@/lib/role-access";

export default function SuppliersLayout({ children }: { children: ReactNode }) {
  return <RolePageGuard roles={OPERATIONS_ROLES}>{children}</RolePageGuard>;
}
