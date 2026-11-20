"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import css from "./settings.module.css";

/**
 * No RolePageGuard here — My Profile, Password & Login, and Appearance are open to every
 * role (self-service). The admin-only subtrees (Tenant Profile, Branches, Main/Catalog/
 * Operations, Alerts & Approvals, and the admin part of Security) each gate themselves in
 * their own layout.tsx instead, following settings/catalog/categories/layout.tsx's pattern.
 *
 * The settings menu lives in the app shell's sidebar, which it replaces inside Settings
 * (UI1 #205); see components/app-shell/settings-menu.tsx and lib/settings-menu.tsx. Who a
 * page's changes reach is stated on its group there, not in a banner on every page.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // This layout never remounts across sub-page navigation, so reset the document's scroll on
  // every sub-page change or a page you'd scrolled down would leave the next one starting
  // mid-scroll.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return <div className={css.page}>{children}</div>;
}
