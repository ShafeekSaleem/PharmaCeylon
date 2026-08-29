"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SettingsSubnav } from "./components/settings-subnav";
import { SettingsScope } from "./components/settings-scope";
import css from "./settings.module.css";

/**
 * No RolePageGuard here — My Profile, Password & Login, and Appearance are open to every
 * role (self-service). The admin-only subtrees (Tenant Profile, Branches, Main/Catalog/
 * Operations, Alerts & Approvals, and the admin part of Security) each gate themselves in
 * their own layout.tsx instead, following settings/catalog/categories/layout.tsx's pattern.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement>(null);

  // .panel is a persisted DOM node (this layout never remounts across sub-page navigation)
  // that scrolls internally — reset its scroll position on every sub-page change so a page
  // you'd scrolled down doesn't leave the next one's content starting mid-scroll.
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className={css.page}>
      <SettingsSubnav />
      <div className={css.panel} ref={panelRef}>
        <SettingsScope />
        {children}
      </div>
    </div>
  );
}
