"use client";

import { useSearchParams } from "next/navigation";
import { PageSubnav, type PageSubnavTab } from "@/components/ui";
import { usePermissions } from "@/lib/permissions";

// Adjustments no longer has its own sub-page — every tab below opens the same
// "New adjustment" modal instead, so it isn't listed as a nav destination.
const TABS: PageSubnavTab[] = [
  { href: "/inventory", label: "Stock overview", match: (p) => p === "/inventory" },
  { href: "/inventory/batches", label: "Batches" },
  { href: "/inventory/movements", label: "Movements" },
  // P5 #51: offline sales whose stock waits on a manager's review.
  { href: "/inventory/stock-cases", label: "Stock cases" },
  // P5 #51 slice 4: offline records the server refused, which stop a counter's sync until decided.
  { href: "/inventory/offline-records", label: "Refused offline records" },
];

const TAB_PERMISSIONS: Record<string, string> = {
  "/inventory/stock-cases": "inventory.resolve_stock_cases",
  "/inventory/offline-records": "sales.review_offline_entries",
};

export function InventorySubnav() {
  const searchParams = useSearchParams();
  const { permissionKeys } = usePermissions();
  const tabs = TABS.map((tab) => {
    const permission = TAB_PERMISSIONS[tab.href];
    return permission ? { ...tab, hidden: !permissionKeys.includes(permission) } : tab;
  });
  const productId = searchParams.get("productId");
  const category = searchParams.get("category");

  // A product or category the user arrived with follows them between tabs; losing it on a tab
  // click is how someone ends up looking at the whole branch's movements by accident.
  const querySuffix = (() => {
    const params = new URLSearchParams();
    if (productId) params.set("productId", productId);
    if (category) params.set("category", category);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  })();

  return <PageSubnav label="Inventory sections" tabs={tabs} querySuffix={querySuffix} />;
}
