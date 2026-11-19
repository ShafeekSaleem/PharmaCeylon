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
  workFilter?: WorkFilter;
};

export const WORK_PRIORITY_CHIPS: PriorityChipDef[] = [
  {
    key: "all",
    label: "All",
    workFilter: "all",
  },
  {
    key: "approvals",
    label: "Needs my decision",
    workFilter: "approvals",
  },
  {
    key: "counter",
    label: "At the counter",
    workFilter: "counter",
  },
  {
    key: "overdue_deliveries",
    label: "Overdue deliveries",
  },
];

export const STOCK_PRIORITY_CHIPS: PriorityChipDef[] = [
  {
    key: "low_stock",
    label: "Low stock",
  },
  {
    key: "near_expiry",
    label: "Near expiry",
  },
  {
    key: "controlled",
    label: "Controlled",
  },
  {
    key: "out_of_stock",
    label: "Out of stock",
  },
];


export function isStockFilter(key: PriorityFilterKey): boolean {
  return (
    key === "low_stock" ||
    key === "near_expiry" ||
    key === "controlled" ||
    key === "out_of_stock"
  );
}