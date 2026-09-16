"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconUser,
  IconHome,
  IconMapPin,
  IconGrid,
  IconShoppingCart,
  IconPackage,
  IconBox,
  IconLock,
  IconSparkles,
  IconBell,
  IconCheckCircle,
} from "@/components/icons";
import { usePermissions } from "@/lib/permissions";
import css from "../settings.module.css";

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Items with no `adminOnly` are reachable by every role — self-service pages. */
  adminOnly?: boolean;
};

type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "General",
    items: [
      { href: "/settings/my-profile", label: "My Profile", icon: <IconUser size={16} /> },
      {
        href: "/settings/tenant-profile",
        label: "Tenant Profile",
        icon: <IconHome size={16} />,
        adminOnly: true,
      },
      { href: "/settings/branches", label: "Branches", icon: <IconMapPin size={16} />, adminOnly: true },
    ],
  },
  {
    label: "Modules",
    items: [
      { href: "/settings/main", label: "Main", icon: <IconGrid size={16} />, adminOnly: true },
      {
        href: "/settings/catalog",
        label: "Catalog",
        icon: <IconPackage size={16} />,
        adminOnly: true,
      },
      {
        href: "/settings/operations",
        label: "Operations",
        icon: <IconBox size={16} />,
        adminOnly: true,
      },
    ],
  },
  {
    label: "Security & Access",
    items: [
      { href: "/settings/password-login", label: "Password & Login", icon: <IconLock size={16} /> },
      // Removed with the rest of "Alerts & Approvals" while its settings did nothing. The
      // thresholds are enforced by the API now, and who may approve their own requests is set
      // here, so the page is back — on its own, not with the still-unenforced alert settings.
      {
        href: "/settings/approval-rules",
        label: "Approval Rules",
        icon: <IconCheckCircle size={16} />,
        adminOnly: true,
      },
    ],
  },
  {
    label: "Preferences",
    items: [
      { href: "/settings/notifications", label: "Notifications", icon: <IconBell size={16} /> },
      { href: "/settings/appearance", label: "Appearance", icon: <IconSparkles size={16} /> },
    ],
  },
];

export function SettingsSubnav() {
  const pathname = usePathname();
  const { permissionKeys } = usePermissions();
  const isAdmin = permissionKeys.includes("tenant.management");

  return (
    <nav className={css.subnav} aria-label="Settings sections">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => !item.adminOnly || isAdmin);
        if (items.length === 0) return null;
        return (
          <div key={group.label} className={css.subnavGroup}>
            <span className={css.subnavGroupLabel}>{group.label}</span>
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`${css.subnavItem}${active ? ` ${css.subnavItemActive}` : ""}`}
                >
                  <span className={css.subnavIcon}>{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
