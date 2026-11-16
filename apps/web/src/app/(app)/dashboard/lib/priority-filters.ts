import toneCss from "@/components/ui/tone-chip.module.css";
import reportsCss from "@/app/(app)/reports/reports.module.css";
import productsCss from "@/app/(app)/products/products.module.css";
import type { WorkFilter } from "@pharmaceylon/shared";

export type PriorityFilterKey =
  | "all"
  | "approvals"
  | "counter"
  | "overdue_deliveries"
  | "low_stock"
  | "near_expiry"
  | "controlled"
  | "out_of_stock";

export type PriorityChipDef = {
  key: PriorityFilterKey;
  label: string;
  toneClass: string;
  workFilter?: WorkFilter;
};

export const WORK_PRIORITY_CHIPS: PriorityChipDef[] = [
  {
    key: "all",
    label: "All",
    toneClass: reportsCss.toggleChipSlate,
    workFilter: "all",
  },
  {
    key: "approvals",
    label: "Needs my decision",
    toneClass: toneCss.skyTone,
    workFilter: "approvals",
  },
  {
    key: "counter",
    label: "At the counter",
    toneClass: toneCss.tealTone,
    workFilter: "counter",
  },
  {
    key: "overdue_deliveries",
    label: "Overdue deliveries",
    toneClass: toneCss.roseTone,
  },
];

export const STOCK_PRIORITY_CHIPS: PriorityChipDef[] = [
  {
    key: "low_stock",
    label: "Low stock",
    toneClass: toneCss.amberTone,
  },
  {
    key: "near_expiry",
    label: "Near expiry",
    toneClass: toneCss.orangeTone,
  },
  {
    key: "controlled",
    label: "Controlled",
    toneClass: toneCss.violetTone,
  },
  {
    key: "out_of_stock",
    label: "Out of stock",
    toneClass: toneCss.dangerStrongTone,
  },
];

export const statusPillBase = productsCss.statusPill;
export const statusPillActive = productsCss.statusPillActive;

export function isStockFilter(key: PriorityFilterKey): boolean {
  return (
    key === "low_stock" ||
    key === "near_expiry" ||
    key === "controlled" ||
    key === "out_of_stock"
  );
}