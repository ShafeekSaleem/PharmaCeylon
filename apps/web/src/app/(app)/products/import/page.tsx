"use client";

import { Suspense } from "react";
import { RolePageGuard } from "@/components/role-access";
import { CATALOG_ROLES } from "@/lib/role-access";
import { ProductImportPage } from "./product-import-page";

export default function ProductImportRoute() {
  return (
    // The products layout already gates on products.view; importing is a separate, elevated
    // permission, so this route asks for it in its own right.
    <RolePageGuard roles={CATALOG_ROLES} permissions={["products.import"]}>
      <Suspense
        fallback={<p style={{ padding: "1rem", color: "var(--pc-muted-fg)" }}>Loading…</p>}
      >
        <ProductImportPage />
      </Suspense>
    </RolePageGuard>
  );
}
