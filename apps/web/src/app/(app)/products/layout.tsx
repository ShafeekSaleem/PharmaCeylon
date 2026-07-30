import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { CATALOG_ROLES } from "@/lib/role-access";

export default function ProductsLayout({ children }: { children: ReactNode }) {
  return <RolePageGuard roles={CATALOG_ROLES}>{children}</RolePageGuard>;
}
