"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import css from "../inventory.module.css";

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
    href: "/inventory/adjustments",
    label: "Adjustments",
    match: (p: string) => p.startsWith("/inventory/adjustments"),
  },
] as const;

export function InventorySubnav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const productId = searchParams.get("productId");

  return (
    <nav className={css.subnav} aria-label="Inventory sections">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        const href = productId
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
