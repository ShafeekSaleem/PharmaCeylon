import type { ReactNode } from "react";
import {
  IconAlertTriangle,
  IconBell,
  IconCheckCircle,
  IconCloud,
  IconCreditCard,
  IconHome,
  IconKeyboard,
  IconLock,
  IconMapPin,
  IconPackage,
  IconReceipt,
  IconSparkles,
  IconTruck,
  IconUser,
} from "@/components/icons";
import { isPersonalAccountPath } from "./back-office-access";

/**
 * Every settings page, in one list (UI1 #205). The settings menu that replaces the main
 * sidebar, the settings home's cards, settings search and the page titles all read this, so a
 * page is named, grouped and found the same way everywhere.
 */

export type SettingsGroupKey = "you" | "pharmacy" | "counter" | "stock" | "alerts";

export type SettingsGroup = {
  key: SettingsGroupKey;
  label: string;
  /** Who a change in this group affects. Stated once on the group, not on every page. */
  scope: string;
};

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { key: "you", label: "You", scope: "Only your account" },
  { key: "pharmacy", label: "Pharmacy", scope: "Everyone" },
  { key: "counter", label: "At the counter", scope: "Everyone" },
  { key: "stock", label: "Stock & buying", scope: "Everyone" },
  { key: "alerts", label: "Reports & alerts", scope: "Everyone" },
];

export type SettingsItem = {
  href: string;
  /** The page's display name: menu, card, breadcrumb and page title all use it. */
  label: string;
  /** One line on the home card when there is no current value to show. */
  description: string;
  group: SettingsGroupKey;
  /** Each item has its own icon, so no two rows in the menu look alike. */
  icon: (size: number) => ReactNode;
  /** Admin pages need `tenant.management`; the rest are self-service for every role. */
  adminOnly?: boolean;
  /** Names of the fields and sections on the page, so search finds "refund limit". */
  keywords: string[];
};

export const SETTINGS_ITEMS: SettingsItem[] = [
  // ── You ──
  {
    href: "/settings/my-profile",
    label: "My Profile",
    description: "Your name, photo and contact details",
    group: "you",
    icon: (s) => <IconUser size={s} />,
    keywords: [
      "name",
      "first name",
      "last name",
      "phone number",
      "email",
      "profile photo",
      "avatar",
      "role",
      "branch access",
    ],
  },
  {
    href: "/settings/password-login",
    label: "Password & Login",
    description: "Change your password and sign out other devices",
    group: "you",
    icon: (s) => <IconLock size={s} />,
    keywords: [
      "password",
      "change password",
      "current password",
      "active sessions",
      "sign out everywhere",
      "password policy",
      "minimum password length",
      "security",
    ],
  },
  {
    href: "/settings/notifications",
    label: "Notifications",
    description: "Which alerts reach you",
    group: "you",
    icon: (s) => <IconBell size={s} />,
    keywords: [
      "inventory alerts",
      "expiry",
      "purchasing",
      "transfers",
      "stocktakes",
      "compliance",
      "low stock alert",
    ],
  },
  {
    href: "/settings/appearance",
    label: "Appearance",
    description: "Theme, density and text size",
    group: "you",
    icon: (s) => <IconSparkles size={s} />,
    keywords: [
      "theme",
      "dark mode",
      "light mode",
      "density",
      "font size",
      "text size",
      "pharmacy brand",
      "accent colour",
      "accent color",
      "sidebar",
      "status colours",
      "chart colours",
      "counter app theme",
    ],
  },

  // ── Pharmacy ──
  {
    href: "/settings/tenant-profile",
    label: "Organization Profile",
    description: "Legal name, registration and contact details",
    group: "pharmacy",
    icon: (s) => <IconHome size={s} />,
    adminOnly: true,
    keywords: [
      "display name",
      "legal name",
      "business registration",
      "vat registration",
      "tax identification",
      "tin",
      "address",
      "phone",
      "email",
      "pharmacy logo",
      "logo",
      "currency",
      "date format",
      "timezone",
      "fiscal year",
      "compliance region",
      "tenant code",
    ],
  },
  {
    href: "/settings/branches",
    label: "Branches",
    description: "Branch details, licences and opening hours",
    group: "pharmacy",
    icon: (s) => <IconMapPin size={s} />,
    adminOnly: true,
    keywords: [
      "branch",
      "branch code",
      "address",
      "manager",
      "nmra pharmacy licence",
      "licence expiry",
      "responsible pharmacist",
      "slmc registration",
      "opening hours",
      "routine hours",
      "extended selling hours",
      "holidays",
      "poya",
      "closed days",
      "sales target",
    ],
  },

  // ── At the counter ──
  {
    href: "/settings/main",
    label: "Counters & receipts",
    description: "Receipt layout, discounts and register numbering",
    group: "counter",
    icon: (s) => <IconReceipt size={s} />,
    adminOnly: true,
    keywords: [
      "receipt",
      "receipt paper size",
      "header text",
      "footer text",
      "default payment method",
      "max discount",
      "discount limit",
      "register numbering",
    ],
  },
  {
    href: "/settings/counters",
    label: "Counters & devices",
    description: "Counter computers and enrollment codes",
    group: "counter",
    icon: (s) => <IconKeyboard size={s} />,
    adminOnly: true,
    keywords: [
      "counter",
      "add counter",
      "computer",
      "enrollment code",
      "enrol",
      "retire computer",
      "report lost",
      "offline sales",
      "devices",
    ],
  },
  {
    href: "/settings/payments",
    label: "Payments",
    description: "Cash and card merchants at the counter",
    group: "counter",
    icon: (s) => <IconCreditCard size={s} />,
    adminOnly: true,
    keywords: ["cash", "card", "card merchant", "external card payments", "payment methods"],
  },
  {
    href: "/settings/offline-policy",
    label: "Offline policy",
    description: "Selling while a counter is offline",
    group: "counter",
    icon: (s) => <IconCloud size={s} />,
    adminOnly: true,
    keywords: [
      "offline selling",
      "offline managers",
      "assignment authority",
      "delegations",
      "restored counters",
      "journal recovery",
      "offline counter journal",
      "sign off",
    ],
  },

  // ── Stock & buying ──
  {
    href: "/settings/catalog",
    label: "Catalog",
    description: "Product display and VAT",
    group: "stock",
    icon: (s) => <IconPackage size={s} />,
    adminOnly: true,
    keywords: [
      "vat rate",
      "vat",
      "tax",
      "tax calculation method",
      "tax breakdown",
      "product view",
      "controlled-substance badge",
      "target gross margin",
      "margin",
      "categories",
      "tags",
    ],
  },
  {
    href: "/settings/operations",
    label: "Operations",
    description: "Stock, purchasing, returns and stocktakes",
    group: "stock",
    icon: (s) => <IconTruck size={s} />,
    adminOnly: true,
    keywords: [
      "low stock threshold",
      "expiry warning",
      "stock picking method",
      "fefo",
      "negative stock",
      "expired-batch sales",
      "po number prefix",
      "supplier payment terms",
      "over-delivery",
      "price increases",
      "price variance",
      "return window",
      "transfer reason",
      "count method",
      "variance tolerance",
    ],
  },

  // ── Reports & alerts ──
  {
    href: "/settings/approval-rules",
    label: "Approval Rules",
    description: "What needs a second person to approve",
    group: "alerts",
    icon: (s) => <IconCheckCircle size={s} />,
    adminOnly: true,
    keywords: [
      "approval",
      "refund limit",
      "refunds over a threshold",
      "purchase orders over a threshold",
      "write-offs",
      "write-off limit",
      "branch stock transfers",
      "controlled substance sales",
      "self-approval",
      "threshold amount",
    ],
  },
  {
    href: "/settings/counter-alerts",
    label: "Counter alerts",
    description: "Who hears about problems at the counters",
    group: "alerts",
    icon: (s) => <IconAlertTriangle size={s} />,
    adminOnly: true,
    keywords: ["counter alerts", "recipients", "cash variance", "offline too long", "alert roles"],
  },
];

export type SettingsAccess = {
  /** Holds `tenant.management`, so the admin pages are open. */
  isAdmin: boolean;
  /** Only the personal pages are open (desktop-live branch, no back-office access). */
  personalOnly: boolean;
};

export function visibleSettingsItems(access: SettingsAccess): SettingsItem[] {
  return SETTINGS_ITEMS.filter(
    (item) =>
      (!item.adminOnly || access.isAdmin) &&
      (!access.personalOnly || isPersonalAccountPath(item.href)),
  );
}

export function groupSettingsItems(
  items: SettingsItem[],
): { group: SettingsGroup; items: SettingsItem[] }[] {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    items: items.filter((item) => item.group === group.key),
  })).filter((entry) => entry.items.length > 0);
}

/** The settings item a path belongs to (a sub-page belongs to its parent's item). */
export function settingsItemFor(pathname: string): SettingsItem | undefined {
  return SETTINGS_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/colour/g, "color")
    .replace(/[^a-z0-9%]+/g, " ")
    .trim();
}

export type SettingsMatch = {
  item: SettingsItem;
  /** The field that matched, when it was a field and not the page name. */
  field?: string;
};

/**
 * Find settings by page name, description or the fields inside the page. Every word of the
 * query must appear (in any order), so "refund limit" finds Approval Rules and "vat" finds
 * Catalog. Name matches come first.
 */
export function searchSettings(items: SettingsItem[], query: string): SettingsMatch[] {
  const words = normalise(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const hasAll = (text: string) => {
    const haystack = normalise(text);
    return words.every((word) => haystack.includes(word));
  };
  const byName: SettingsMatch[] = [];
  const byField: SettingsMatch[] = [];
  for (const item of items) {
    if (hasAll(item.label) || hasAll(`${item.label} ${item.description}`)) {
      byName.push({ item });
      continue;
    }
    const field = item.keywords.find(hasAll);
    if (field) byField.push({ item, field });
  }
  return [...byName, ...byField];
}
