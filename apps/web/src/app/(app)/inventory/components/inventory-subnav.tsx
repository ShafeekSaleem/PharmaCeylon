"use client";

import { useSearchParams } from "next/navigation";
import { PageSubnav, type PageSubnavTab } from "@/components/ui";

// Adjustments no longer has its own sub-page — every tab below opens the same
// "New adjustment" modal instead, so it isn't listed as a nav destination.
const TABS: PageSubnavTab[] = [
  { href: "/inventory", label: "Stock overview", match: (p) => p === "/inventory" },
  { href: "/inventory/batches", label: "Batches" },
  { href: "/inventory/movements", label: "Movements" },
];

export function InventorySubnav() {
  const searchParams = useSearchParams();
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

  return <PageSubnav label="Inventory sections" tabs={TABS} querySuffix={querySuffix} />;
}
