"use client";

import { useEffect, type ReactNode } from "react";
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

  // The page scrolls as one document (see settings.module.css) — this layout never remounts
  // across sub-page navigation, so reset the document's scroll on every sub-page change or a
  // page you'd scrolled down would leave the next one's content starting mid-scroll.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className={css.page}>
      <SettingsSubnav />
      <div className={css.panel}>
        <SettingsScope />
        {children}
      </div>
    </div>
  );
}
