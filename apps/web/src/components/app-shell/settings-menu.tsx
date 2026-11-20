"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { IconChevronLeft, IconSettings } from "@/components/icons";
import {
  groupSettingsItems,
  settingsGroupScope,
  settingsItemCovers,
  visibleSettingsItems,
} from "@/lib/settings-menu";
import styles from "./app-shell.module.css";

type Props = {
  pathname: string;
  /** Where "Back to app" returns: the last page outside Settings. Null hides the link, for
   *  someone with nowhere in the web app to go back to. */
  backHref: string | null;
  isAdmin: boolean;
  personalOnly: boolean;
  collapsed: boolean;
  onNavigate: () => void;
};

/**
 * Inside Settings the main sidebar steps aside for this menu (UI1 #205, decision 3), with
 * "Back to app" at the top. Each group says once who its changes reach, so no page needs its
 * own Personal / Organization-wide banner.
 */
export function SettingsMenu({
  pathname,
  backHref,
  isAdmin,
  personalOnly,
  collapsed,
  onNavigate,
}: Props) {
  const groups = groupSettingsItems(visibleSettingsItems({ isAdmin, personalOnly }));
  const tip = (label: string) =>
    collapsed ? { "data-tooltip": label, "data-tooltip-placement": "right" as const } : {};
  const homeActive = pathname === "/settings";

  // On a short screen the menu scrolls; keep the open page's item in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const current = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    current?.scrollIntoView?.({ block: "nearest" });
  }, [pathname]);

  return (
    <nav ref={navRef} className={styles.sidebarNav} aria-label="Settings">
      {backHref && (
        <Link
          href={backHref}
          className={`${styles.navItem} ${styles.settingsBack}`}
          onClick={onNavigate}
          {...tip("Back to app")}
        >
          <span className={styles.navItemIcon}>
            <IconChevronLeft size={18} />
          </span>
          <span className={styles.navItemLabel}>Back to app</span>
        </Link>
      )}

      <Link
        href="/settings"
        className={`${styles.navItem} ${styles.settingsHome}${homeActive ? ` ${styles.navItemActive}` : ""}`}
        aria-current={homeActive ? "page" : undefined}
        onClick={onNavigate}
        {...tip("Settings")}
      >
        <span className={styles.navItemIcon}>
          <IconSettings size={18} />
        </span>
        <span className={styles.navItemLabel}>Settings</span>
      </Link>

      {groups.map(({ group, items }) => (
        <div
          key={group.key}
          className={styles.navGroup}
          role="group"
          aria-label={`${group.label}: ${settingsGroupScope(group)}`}
        >
          <span className={styles.navGroupLabel} aria-hidden title={group.scopeNote}>
            {group.label}
            <span className={styles.settingsScope}> · {group.scope}</span>
          </span>
          {items.map((item) => {
            const active = settingsItemCovers(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem}${active ? ` ${styles.navItemActive}` : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                {...tip(item.label)}
              >
                <span className={styles.navItemIcon}>{item.icon(18)}</span>
                <span className={styles.navItemLabel}>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
