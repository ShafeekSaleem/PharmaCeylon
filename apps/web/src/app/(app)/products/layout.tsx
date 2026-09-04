import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { CATALOG_ROLES } from "@/lib/role-access";

/**
 * Admits `catalog.view` as well as `products.view`.
 *
 * Search Catalog (`catalog.view`) was folded into this page's Reference tab. Both keys default
 * to all five built-in roles, so out of the box nothing changes — but a tenant that had
 * customised its roles to grant one and not the other would otherwise have lost a screen to a
 * consolidation, which is not a change anyone asked for. The two scopes are then gated
 * individually inside the page.
 */
export default function ProductsLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={CATALOG_ROLES} permissions={["products.view", "catalog.view"]}>
      {children}
    </RolePageGuard>
  );
}
