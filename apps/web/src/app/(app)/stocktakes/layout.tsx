import type { ReactNode } from "react";
import { RolePageGuard } from "@/components/role-access";
import { STOCKTAKE_ROLES } from "@/lib/role-access";

export default function StocktakesLayout({ children }: { children: ReactNode }) {
  return (
    <RolePageGuard roles={STOCKTAKE_ROLES} permissions={["stocktakes.use"]}>
      {children}
    </RolePageGuard>
  );
}
