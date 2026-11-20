import type { AppearancePrefs } from "@/lib/appearance";
import type { NotificationPreferences } from "@/lib/notifications-client";
import type { TenantSettings } from "./tenant-settings";

/**
 * What the settings home shows on each card and in "Needs attention" (UI1 #205), worked out
 * from whatever reads succeeded. Every field is optional: a card whose read failed, or that
 * the person may not read, falls back to its description rather than showing a wrong value.
 */
export type SettingsOverview = {
  user?: { fullName: string; email: string };
  appearance?: AppearancePrefs;
  notifications?: NotificationPreferences;
  settings?: TenantSettings;
  organization?: { displayName: string; hasLogo: boolean };
  branchCount?: number;
  /** Counters in use at the selected branch. */
  counterCount?: number;
  branchName?: string;
  /** The branch sells on PharmaCeylon POS (live or in a fallback), so it needs counters. */
  desktopLive?: boolean;
  /** Restored counters waiting for an owner or manager to acknowledge. */
  restoresWaiting?: number;
  /** Counter journal recoveries waiting for approval (not stale). */
  recoveriesWaiting?: number;
};

const THEME: Record<AppearancePrefs["theme"], string> = {
  system: "Match device",
  light: "Light",
  dark: "Dark",
};
const DENSITY: Record<AppearancePrefs["density"], string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};
const FONT: Record<AppearancePrefs["fontSize"], string> = {
  small: "small text",
  medium: "medium text",
  large: "large text",
};

const PAPER: Record<string, string> = { "80mm": "80 mm", "58mm": "58 mm", a4: "A4" };

const NOTIFICATION_KEYS: (keyof NotificationPreferences)[] = [
  "inventoryEnabled",
  "expiryEnabled",
  "purchasingEnabled",
  "transfersEnabled",
  "stocktakesEnabled",
  "complianceEnabled",
  "systemEnabled",
];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The current value line for each settings card, by page href. */
export function settingsValues(o: SettingsOverview): Partial<Record<string, string>> {
  const values: Partial<Record<string, string>> = {};
  const s = o.settings;

  if (o.user) values["/settings/my-profile"] = `${o.user.fullName} · ${o.user.email}`;
  if (s) {
    values["/settings/password-login"] =
      `Passwords at least ${plural(s.passwordMinLength, "character")}`;
  }
  if (o.notifications) {
    const off = NOTIFICATION_KEYS.filter((key) => !o.notifications?.[key]).length;
    values["/settings/notifications"] =
      off === 0 ? "All alerts on" : `${plural(off, "alert type")} turned off`;
  }
  if (o.appearance) {
    const a = o.appearance;
    values["/settings/appearance"] =
      `${THEME[a.theme]} · ${DENSITY[a.density]} · ${FONT[a.fontSize]}`;
  }
  if (o.organization) values["/settings/tenant-profile"] = o.organization.displayName;
  if (o.branchCount !== undefined)
    values["/settings/branches"] = plural(o.branchCount, "branch", "branches");
  if (s) {
    values["/settings/main"] =
      `${PAPER[s.receiptPaperSize] ?? s.receiptPaperSize} receipts · discounts up to ${s.posMaxDiscountPercent}% without approval`;
  }
  if (o.counterCount !== undefined) {
    const where = o.branchName ? ` at ${o.branchName}` : " at this branch";
    values["/settings/counters"] =
      o.counterCount === 0 ? `No counters${where}` : `${plural(o.counterCount, "counter")}${where}`;
  }
  if (s) {
    values["/settings/catalog"] =
      s.vatRatePercent === null ? "VAT at the standard rate" : `VAT ${s.vatRatePercent}%`;
    values["/settings/operations"] =
      `Low stock at ${plural(s.lowStockThresholdUnits, "unit")} · expiry warning ${plural(s.expiryWarningDays, "day")}`;
    // Controlled substance sales always need approval, so it counts as one rule that is on.
    const on =
      1 +
      [
        s.approvalRequiredPurchaseOrderThreshold !== null,
        s.approvalRequiredForBranchTransfers,
        s.approvalRequiredReturnThreshold !== null,
        s.approvalRequiredWriteOffThreshold !== null,
      ].filter(Boolean).length;
    values["/settings/approval-rules"] = `${on} of 5 rules on`;
  }
  return values;
}

export type AttentionItem = {
  href: string;
  /** What is wrong, in a few words. */
  title: string;
  /** What to do about it. */
  detail: string;
};

/** Settings that are waiting on someone, most pressing first. Admin reads only. */
export function needsAttention(o: SettingsOverview): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (o.restoresWaiting) {
    items.push({
      href: "/settings/offline-policy",
      title: `${plural(o.restoresWaiting, "restored counter")} waiting for you`,
      detail: "Acknowledge the restore before the counter sells offline again.",
    });
  }
  if (o.recoveriesWaiting) {
    items.push({
      href: "/settings/offline-policy",
      title: `${plural(o.recoveriesWaiting, "counter journal recovery", "counter journal recoveries")} waiting for approval`,
      detail: "Check what the counter recorded, then approve the recovery.",
    });
  }
  if (o.counterCount === 0 && o.desktopLive) {
    items.push({
      href: "/settings/counters",
      title: o.branchName ? `No counters at ${o.branchName}` : "No counters at this branch",
      detail: "Add a counter and enroll its computer before selling on PharmaCeylon POS.",
    });
  }
  if (o.organization && !o.organization.hasLogo) {
    items.push({
      href: "/settings/tenant-profile",
      title: "No pharmacy logo",
      detail: "Add your logo so receipts and documents can carry it.",
    });
  }
  return items;
}
