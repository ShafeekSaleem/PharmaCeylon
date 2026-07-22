"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { RoleLink } from "@/components/role-access";
import { INVENTORY_WRITE_ROLES } from "@/lib/role-access";
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
    roles: INVENTORY_WRITE_ROLES,
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
        const roles = "roles" in tab ? tab.roles : undefined;

        if (roles) {
          return (
            <RoleLink
              key={tab.href}
              href={href}
              roles={roles}
              className={`${css.subnavLink}${active ? ` ${css.subnavLinkActive}` : ""}`}
            >
              {tab.label}
            </RoleLink>
          );
        }

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
