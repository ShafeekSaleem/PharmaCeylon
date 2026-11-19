import type { DashboardRole } from "./dashboard-role";

/**
 * The fixed cards beside the work queue, in order: stock health, then one more. Never draggable
 * and not in the customise canvas. The business overview and branch comparison cards moved to
 * Customise when the dashboard started following the top-bar branch (UI1 #205); the daily sales
 * bars below the queue replace their sales trend.
 */
export const FIXED_WIDGET_KEYS: Record<DashboardRole, readonly string[]> = {
  owner: ["owner.inventory-health", "owner.payment-mix"],
  manager: ["manager.inventory-health", "manager.staff-productivity"],
  pharmacist: [],
  cashier: [],
  inventory_clerk: [],
};

export function isFixedWidget(role: DashboardRole, key: string): boolean {
  return FIXED_WIDGET_KEYS[role].includes(key);
}

export const WORK_PAGE_SIZE = 8;