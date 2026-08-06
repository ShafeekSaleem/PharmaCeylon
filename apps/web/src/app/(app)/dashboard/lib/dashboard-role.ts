import type { RoleName } from "@/lib/role-access";

/** Dashboard surfaces — mirrors DB roles (no separate platform Admin view). */
export type DashboardRole =
  | "owner"
  | "manager"
  | "pharmacist"
  | "cashier"
  | "inventory_clerk"
  | "analyst";

const ROLE_PRIORITY: RoleName[] = [
  "owner",
  "manager",
  "pharmacist",
  "inventory_clerk",
  "cashier",
  "analyst",
];

export const DASHBOARD_ROLE_LABELS: Record<DashboardRole, string> = {
  owner: "Owner",
  manager: "Manager",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  inventory_clerk: "Inventory Clerk",
  analyst: "Analyst",
};

export const DASHBOARD_GREETINGS: Record<DashboardRole, string> = {
  owner: "Welcome back! Here's your business-wide overview across all branches.",
  manager:
    "Welcome back! Here's an overview of your branch operations. Track performance, manage your team, and keep inventory healthy.",
  pharmacist:
    "Welcome back! Review holds, near-expiry stock, and counter volume — keep dispense safe and shelves healthy.",
  cashier: "Welcome back! Ready to serve your customers. Use shortcuts below to speed up checkout and manage sales.",
  inventory_clerk: "Keep stock healthy — movements, expiry, and replenishment at a glance.",
  analyst: "Insights overview — trends, stock health, and reorder signals.",
};

/** Pick the highest-privilege branch role for dashboard layout. */
export function resolvePrimaryDashboardRole(userRoles: string[]): RoleName {
  for (const role of ROLE_PRIORITY) {
    if (userRoles.includes(role)) return role;
  }
  return "cashier";
}

export function formatRoleLabel(role: DashboardRole): string {
  return DASHBOARD_ROLE_LABELS[role] ?? role;
}
