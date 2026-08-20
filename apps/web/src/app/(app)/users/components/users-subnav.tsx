"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import css from "../users.module.css";

const TABS = [
  { href: "/users", label: "Staff", match: (p: string) => p === "/users" },
  {
    href: "/users/roles",
    label: "Roles & permissions",
    match: (p: string) => p.startsWith("/users/roles"),
  },
] as const;

export function UsersSubnav() {
  const pathname = usePathname();

  return (
    <nav className={css.subnav} aria-label="Users sections">
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`${css.subnavLink}${active ? ` ${css.subnavLinkActive}` : ""}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
