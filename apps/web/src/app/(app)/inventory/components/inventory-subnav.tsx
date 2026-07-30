"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import css from "../inventory.module.css";

// Adjustments no longer has its own sub-page — every tab below opens the same
// "New adjustment" modal instead, so it isn't listed as a nav destination.
const TABS = [
  {
    href: "/inventory",
    label: "Stock overview",
    match: (p: string) => p === "/inventory",
  },
  {
    href: "/inventory/batches",
    label: "Batches",
    match: (p: string) => p.startsWith("/inventory/batches"),
  },
  {
    href: "/inventory/movements",
    label: "Movements",
    match: (p: string) => p.startsWith("/inventory/movements"),
  },
] as const;

export function InventorySubnav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const productId = searchParams.get("productId");
  const category = searchParams.get("category");
  const querySuffix = (() => {
    const params = new URLSearchParams();
    if (productId) params.set("productId", productId);
    if (category) params.set("category", category);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  })();

  return (
    <nav className={css.subnav} aria-label="Inventory sections">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        const href =
          tab.href === "/inventory/movements" && category
            ? `${tab.href}${querySuffix}`
            : productId
              ? `${tab.href}?productId=${encodeURIComponent(productId)}`
              : tab.href;

        return (
          <Link
            key={tab.href}
            href={href}
            className={`${css.subnavLink}${active ? ` ${css.subnavLinkActive}` : ""}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
