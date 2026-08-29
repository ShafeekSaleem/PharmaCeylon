"use client";

import type { ReactNode } from "react";
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
