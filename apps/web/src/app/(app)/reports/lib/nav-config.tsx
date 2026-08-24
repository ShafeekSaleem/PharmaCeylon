import type { ReactNode } from "react";
import {
  IconActivity,
  IconBarChart,
  IconBox,
  IconTruck,
} from "@/components/icons";

export type CategoryKey =
  | "sales"
  | "profitability"
  | "inventory"
  | "purchasing";

/** The reports this page actually renders against real data. Every other key below is a scoped-out placeholder — visible so the nav shape doesn't need a redesign when they're built, but not routed to real logic anywhere. */
export type RealReportKey =
  | "sales-summary"
  | "product-sales"
  | "category-sales"
  | "branch-sales"
  | "cashier-performance"
  | "payment-methods"
  | "returns-discounts"
  | "gross-profit"
  | "margin-by-product"
  | "margin-by-category"
  | "branch-profitability"
  | "expiry-batch-risk"
  | "inventory-summary"
  | "stock-health"
  | "stock-movement"
  | "transfers-report"
  | "stocktakes-report"
  | "purchase-summary"
  | "supplier-spend"
  | "supplier-performance";
export type ReportKey = RealReportKey | (string & {});

/** Deep-links to a report key that has since been renamed/merged resolve to its replacement
 *  instead of falling through to a blank/coming-soon state — bookmarks and any saved links keep
 *  working. Dead Stock and Stock Ageing both merged into the single Stock Health report. */
export const REPORT_KEY_ALIASES: Record<string, ReportKey> = {
  "stock-value": "inventory-summary",
  "dead-stock": "stock-health",
  "stock-ageing": "stock-health",
  "near-expiry": "expiry-batch-risk",
};

export function resolveReportKeyAlias(key: ReportKey): ReportKey {
  return REPORT_KEY_ALIASES[key] ?? key;
}

export type PeriodOption = { value: number; label: string };

const DAYS_PERIOD_OPTIONS: PeriodOption[] = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

export type ReportDef = {
  key: ReportKey;
  label: string;
  comingSoon?: boolean;
  periodLabel?: string;
  periodOptions?: PeriodOption[];
  defaultPeriod?: number;
  /** Only shown once the tenant has at least this many branches — e.g. Branch Profitability is
   *  meaningless (and would just be an empty comparison) for a single-branch tenant. Omitted =
   *  always visible. */
  minBranches?: number;
};

export type CategoryDef = {
  key: CategoryKey;
  label: string;
  icon: ReactNode;
  comingSoon?: boolean;
  reports: ReportDef[];
};

export const CATEGORIES: CategoryDef[] = [
  {
    key: "sales",
    label: "Sales",
    icon: <IconActivity size={16} />,
    reports: [
      { key: "sales-summary", label: "Sales Summary", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "product-sales", label: "Product Sales", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "category-sales", label: "Category Sales", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "branch-sales", label: "Branch Sales", periodLabel: "Period", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30, minBranches: 2 },
      { key: "cashier-performance", label: "Cashier Performance", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "payment-methods", label: "Payment Methods", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "returns-discounts", label: "Returns", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
    ],
  },
  {
    key: "profitability",
    label: "Profitability",
    icon: <IconBarChart size={16} />,
    reports: [
      { key: "gross-profit", label: "Profit Summary", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "margin-by-product", label: "Product Profitability", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "margin-by-category", label: "Category Profitability", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "branch-profitability", label: "Branch Profitability", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30, minBranches: 2 },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    icon: <IconBox size={16} />,
    reports: [
      { key: "inventory-summary", label: "Inventory Summary" },
      { key: "stock-health", label: "Stock Health" },
      {
        key: "expiry-batch-risk",
        label: "Expiry & Batch Risk",
        periodLabel: "Window",
        periodOptions: [
          { value: 30, label: "Within 30 days" },
          { value: 60, label: "Within 60 days" },
          { value: 90, label: "Within 90 days" },
        ],
        defaultPeriod: 90,
      },
      { key: "stock-movement", label: "Movement & Turnover", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "transfers-report", label: "Transfers", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "stocktakes-report", label: "Stocktakes", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
    ],
  },
  {
    key: "purchasing",
    label: "Purchasing",
    icon: <IconTruck size={16} />,
    reports: [
      { key: "purchase-summary", label: "Purchase Summary", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "supplier-spend", label: "Supplier Spend", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "supplier-performance", label: "Supplier Performance", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
    ],
  },
];

export function categoryDef(key: CategoryKey): CategoryDef {
  return CATEGORIES.find((c) => c.key === key) ?? CATEGORIES[0]!;
}

export function defaultReportFor(key: CategoryKey): ReportKey | undefined {
  return categoryDef(key).reports[0]?.key;
}

export function reportDef(category: CategoryKey, report: ReportKey): ReportDef | undefined {
  return categoryDef(category).reports.find((r) => r.key === report);
}
