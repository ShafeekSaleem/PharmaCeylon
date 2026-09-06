import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { CATALOG_ROLES } from "@/lib/role-access";

/**
 * Same gate the two worklists it replaces used: reading the queue is `products.view`, and every
 * action inside it is separately checked against `products.manage`. Consolidating four screens
 * into one must not change who can reach the work.
 */
export default function CatalogManageLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <RolePageGuard roles={CATALOG_ROLES} permissions={["products.view"]}>
      {children}
    </RolePageGuard>
  );
}
