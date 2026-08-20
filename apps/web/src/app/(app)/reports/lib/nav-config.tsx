import type { ReactNode } from "react";
import {
  IconActivity,
  IconBarChart,
  IconBox,
  IconClipboardList,
  IconTruck,
} from "@/components/icons";

export type CategoryKey =
  | "sales"
  | "profitability"
  | "inventory"
  | "purchasing"
  | "operations";

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
  | "low-margin-products"
  | "near-expiry"
  | "dead-stock"
  | "stock-value";
export type ReportKey = RealReportKey | (string & {});

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
      { key: "branch-sales", label: "Branch Sales", periodLabel: "Period", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
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
      { key: "gross-profit", label: "Gross Profit", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "margin-by-product", label: "Margin by Product", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "margin-by-category", label: "Margin by Category", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
      { key: "low-margin-products", label: "Low-Margin Products", periodLabel: "Range", periodOptions: DAYS_PERIOD_OPTIONS, defaultPeriod: 30 },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    icon: <IconBox size={16} />,
    reports: [
      { key: "stock-value", label: "Stock Value" },
      {
        key: "near-expiry",
        label: "Near Expiry",
        periodLabel: "Window",
        periodOptions: [
          { value: 30, label: "Within 30 days" },
          { value: 60, label: "Within 60 days" },
          { value: 90, label: "Within 90 days" },
        ],
        defaultPeriod: 90,
      },
      {
        key: "dead-stock",
        label: "Dead Stock",
        periodLabel: "No sale in",
        periodOptions: [
          { value: 60, label: "60+ days" },
          { value: 90, label: "90+ days" },
          { value: 180, label: "180+ days" },
        ],
        defaultPeriod: 90,
      },
      { key: "stock-ageing", label: "Stock Ageing", comingSoon: true },
      { key: "stock-movement", label: "Stock Movement", comingSoon: true },
    ],
  },
  {
    key: "purchasing",
    label: "Purchasing",
    icon: <IconTruck size={16} />,
    comingSoon: true,
    reports: [
      { key: "purchase-summary", label: "Purchase Summary", comingSoon: true },
      { key: "supplier-spend", label: "Supplier Spend", comingSoon: true },
      { key: "supplier-performance", label: "Supplier Performance", comingSoon: true },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    icon: <IconClipboardList size={16} />,
    comingSoon: true,
    reports: [
      { key: "transfers-summary", label: "Transfers", comingSoon: true },
      { key: "returns-summary", label: "Returns", comingSoon: true },
      { key: "stocktake-summary", label: "Stocktakes", comingSoon: true },
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
