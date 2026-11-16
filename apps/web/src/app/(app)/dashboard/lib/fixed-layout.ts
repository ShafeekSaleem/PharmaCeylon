import type { DashboardRole } from "./dashboard-role";

/** Fixed v6 grid widgets — never draggable and not in the customise canvas. */
export const FIXED_WIDGET_KEYS: Record<DashboardRole, readonly string[]> = {
  owner: [
    "owner.inventory-health",
    "owner.payment-mix",
    "owner.business-overview",
    "owner.branch-revenue-contribution",
  ],
  manager: [
    "manager.inventory-health",
    "manager.staff-productivity",
    "manager.business-overview",
    "manager.branch-sales-vs-target",
  ],
  pharmacist: [],
  cashier: [],
  inventory_clerk: [],
};

export function isFixedWidget(role: DashboardRole, key: string): boolean {
  return FIXED_WIDGET_KEYS[role].includes(key);
}

export const WORK_PAGE_SIZE = 8;