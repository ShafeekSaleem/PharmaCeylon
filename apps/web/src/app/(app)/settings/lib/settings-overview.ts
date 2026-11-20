import {
  effectiveDefaultPaymentMethod,
  ONLINE_PAYMENT_METHOD_LABELS,
  type CounterPolicy,
} from "@pharmaceylon/shared";
import type { AppearancePrefs } from "@/lib/appearance";
import type { NotificationPreferences } from "@/lib/notifications-client";
import { APPROVAL_RULES } from "../approval-rules/rules";
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
  /** The alert types this person has a toggle for (the Notifications page's rows). */
  notificationKeys?: (keyof NotificationPreferences)[];
  settings?: TenantSettings;
  organization?: { displayName: string; hasLogo: boolean };
  branchCount?: number;
  /** Counters in use at the selected branch. */
  counterCount?: number;
  branchName?: string;
  /** The selected branch's counter policy: its payment methods and offline selling. */
  counterPolicy?: CounterPolicy;
  /** The branch sells on PharmaCeylon POS (live or in a fallback), so it needs counters. */
  desktopLive?: boolean;
  /** Restored counters waiting for an owner or manager to acknowledge. */
  restoresWaiting?: number;
  /** Counter journal recoveries waiting for approval (not stale). */
  recoveriesWaiting?: number;
  /** Recoveries waiting on the counter to report its journal again before anyone can approve. */
  recoveriesStale?: number;
  /** The "Needs attention" checks this person may run. Only these are checked or claimed. */
  checks?: AttentionCheck[];
  /** No branch is selected, so the branch checks could not run. */
  noBranch?: boolean;
  /** Checks that should have run and did not: a read failed, or no branch was selected. */
  unchecked?: AttentionCheck[];
};

/** The things "Needs attention" looks at. */
export type AttentionCheck = "restores" | "recoveries" | "counters" | "logo";

const CHECK_NAMES: Record<AttentionCheck, string> = {
  restores: "restored counters",
  recoveries: "counter journal recoveries",
  counters: "counters",
  logo: "the pharmacy logo",
};

const CHECK_PAGES: Record<AttentionCheck, string> = {
  restores: "/settings/offline-selling",
  recoveries: "/settings/offline-selling",
  counters: "/settings/counters",
  logo: "/settings/tenant-profile",
};

/** Checks that look at the selected branch only, so their rows name it. */
const BRANCH_CHECKS: AttentionCheck[] = ["restores", "recoveries", "counters"];

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

const PAPER: Record<string, string> = {
  "80mm": "80 mm",
  "58mm": "58 mm",
  a4: "A4",
};
const PAYMENT: Record<string, string> = {
  cash: "cash",
  card: "card",
  split: "split",
};

/** "Cash and card", or a count once the list would not fit on a card. */
function methodList(policy: CounterPolicy): string {
  const names = [
    "Cash",
    ...policy.onlinePaymentMethods.map((m) => ONLINE_PAYMENT_METHOD_LABELS[m].toLowerCase()),
  ];
  if (names.length > 2) return `${names.length} ways to pay`;
  return names.join(" and ");
}

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
      `Pharmacy rule: passwords at least ${plural(s.passwordMinLength, "character")}`;
  }
  if (o.notifications && o.notificationKeys) {
    const off = o.notificationKeys.filter((key) => !o.notifications?.[key]).length;
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
  const where = o.branchName ? ` at ${o.branchName}` : " at this branch";
  if (o.counterCount !== undefined) {
    values["/settings/counters"] =
      o.counterCount === 0 ? `No counters${where}` : `${plural(o.counterCount, "counter")}${where}`;
  }
  if (s) {
    values["/settings/receipts"] =
      `${PAPER[s.receiptPaperSize] ?? s.receiptPaperSize} receipts · ${s.posAutoPrintReceipt ? "printed after every sale" : "printed on request"}`;
  }
  if (o.counterPolicy) {
    // What the branch's counters actually start on: a branch without card starts on cash.
    const method =
      s &&
      effectiveDefaultPaymentMethod(
        s.posDefaultPaymentMethod,
        o.counterPolicy.onlinePaymentMethods,
      );
    const start = method ? ` · starts on ${PAYMENT[method] ?? method}` : "";
    values["/settings/payments"] = `${methodList(o.counterPolicy)}${where}${start}`;
    values["/settings/offline-selling"] = o.counterPolicy.offlineEnabled
      ? `Allowed${where}`
      : `Off${where}`;
  }
  if (s) {
    values["/settings/catalog"] =
      s.vatRatePercent === null ? "VAT at the standard rate" : `VAT ${s.vatRatePercent}%`;
    values["/settings/operations"] =
      `Low stock at ${plural(s.lowStockThresholdUnits, "unit")} · expiry warning ${plural(s.expiryWarningDays, "day")}`;
    const on = APPROVAL_RULES.filter((rule) => rule.isOn(s)).length;
    values["/settings/approval-rules"] = `${on} of ${APPROVAL_RULES.length} rules on`;
  }
  return values;
}

export type AttentionItem = {
  href: string;
  /** What is wrong, in a few words. */
  title: string;
  /** What to do about it. */
  detail: string;
  /** A check that could not run, shown quietly: it is not a problem, but not an all-clear. */
  unchecked?: boolean;
};

/**
 * Settings that are waiting on someone, most pressing first, then any check that could not
 * run. An empty list is an all-clear, so it only comes back empty when every check this
 * person may run did run.
 */
export function needsAttention(o: SettingsOverview): AttentionItem[] {
  const checks = o.checks ?? [];
  const unchecked = new Set(o.unchecked ?? []);
  const ran = (check: AttentionCheck) => checks.includes(check) && !unchecked.has(check);
  const at = o.branchName ? ` at ${o.branchName}` : " at this branch";
  const items: AttentionItem[] = [];

  if (ran("restores") && o.restoresWaiting) {
    items.push({
      href: CHECK_PAGES.restores,
      title: `${plural(o.restoresWaiting, "restored counter")}${at} waiting for you`,
      detail: "Acknowledge the restore before the counter sells offline again.",
    });
  }
  if (ran("recoveries") && o.recoveriesWaiting) {
    items.push({
      href: CHECK_PAGES.recoveries,
      title: `${plural(o.recoveriesWaiting, "counter journal recovery", "counter journal recoveries")}${at} waiting for approval`,
      detail: "Check what the counter recorded, then approve the recovery.",
    });
  }
  if (ran("recoveries") && o.recoveriesStale) {
    items.push({
      href: CHECK_PAGES.recoveries,
      title: `${plural(o.recoveriesStale, "counter journal recovery", "counter journal recoveries")}${at} out of date`,
      detail: "Needs the counter to report again before anyone can approve it.",
    });
  }
  if (ran("counters") && o.counterCount === 0 && o.desktopLive) {
    items.push({
      href: CHECK_PAGES.counters,
      title: `No counters${at}`,
      detail: "Add a counter and enroll its computer before selling on PharmaCeylon POS.",
    });
  }
  if (ran("logo") && o.organization && !o.organization.hasLogo) {
    items.push({
      href: CHECK_PAGES.logo,
      title: "No pharmacy logo",
      detail: "Add your logo so receipts and documents can carry it.",
    });
  }
  for (const check of checks) {
    if (!unchecked.has(check)) continue;
    const where = BRANCH_CHECKS.includes(check) ? at : "";
    items.push({
      href: CHECK_PAGES[check],
      title: `Couldn't check ${CHECK_NAMES[check]}${where}`,
      detail: o.noBranch
        ? "Choose a branch to check it."
        : "Open the page to check it yourself, or try again later.",
      unchecked: true,
    });
  }
  return items;
}
