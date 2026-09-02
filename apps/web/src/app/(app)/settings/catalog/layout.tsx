import type { ReactNode } from "react";

/**
 * No shared gate here — Product Display/Tax/Profitability (catalog/page.tsx) are
 * tenant.management-only and gate themselves locally, while categories/ and tags/ are
 * reachable by anyone with product_meta.view (inventory clerks manage catalog metadata from
 * the Products page too) and gate themselves in their own layout.tsx. A blanket
 * tenant.management gate here would block those more permissive subtrees before their own
 * guard ever runs.
 */
export default function CatalogSettingsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
