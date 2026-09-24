"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import css from "./page-subnav.module.css";

export type PageSubnavTab = {
  href: string;
  label: string;
  /** Defaults to "this exact path, or any path under it". */
  match?: (pathname: string) => boolean;
  /** Small count or status shown after the label, e.g. deliveries awaiting an invoice. */
  badge?: string | number | null;
  hidden?: boolean;
};

type Props = {
  /** Names the group for screen readers: "Inventory sections", "Purchasing sections". */
  label: string;
  tabs: readonly PageSubnavTab[];
  /** Appended to every tab's href — keeps a product or category filter across tabs. */
  querySuffix?: string;
  className?: string;
};

/**
 * The tab strip a workspace uses for its own sections.
 *
 * Inventory, Users and Purchasing had each grown their own copy against their own page CSS, so
 * the same idea drifted apart three ways. One component, one set of tokens, every workspace.
 */
export function PageSubnav({ label, tabs, querySuffix = "", className }: Props) {
  const pathname = usePathname();
  const visible = tabs.filter((tab) => !tab.hidden);

  return (
    <nav className={[css.subnav, className ?? ""].filter(Boolean).join(" ")} aria-label={label}>
      {visible.map((tab) => {
        const active = tab.match
          ? tab.match(pathname)
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={`${tab.href}${querySuffix}`}
            aria-current={active ? "page" : undefined}
            className={`${css.subnavLink}${active ? ` ${css.subnavLinkActive}` : ""}`}
          >
            {tab.label}
            {tab.badge !== null && tab.badge !== undefined && tab.badge !== "" ? (
              <span className={css.badge}>{tab.badge}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
