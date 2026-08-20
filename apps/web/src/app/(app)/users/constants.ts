import type { RoleName } from "@/lib/role-access";

export const ROLE_ORDER: RoleName[] = [
  "owner",
  "manager",
  "pharmacist",
  "cashier",
  "inventory_clerk",
];

export const ROLE_LABELS: Record<RoleName, string> = {
  owner: "Owner",
  manager: "Manager",
  pharmacist: "Pharmacist",
  cashier: "Cashier",
  inventory_clerk: "Inventory Clerk",
  custom: "Custom role",
};

/** Fixed categorical color per role — identity, not a status signal. */
export const ROLE_COLORS: Record<RoleName, string> = {
  owner: "#a855f7",
  manager: "#2563eb",
  pharmacist: "#0d9488",
  cashier: "#d97706",
  inventory_clerk: "#4f46e5",
  custom: "#0891b2",
};

export const ROLE_FILTER_OPTIONS = [
  { value: "all", label: "All roles" },
  ...ROLE_ORDER.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
];

export const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Deactivated" },
];

/** Roles that can co-sign controlled dispensing at the till — mirrors the
 * API's `APPROVER_ROLES` in `pharmacist-approval.service.ts`. Only these
 * roles can ever have a POS till PIN. */
export const DISPENSE_APPROVER_ROLES: RoleName[] = ["owner", "manager", "pharmacist"];
