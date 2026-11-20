import type { NotificationPreferences } from "@/lib/notifications-client";

/** One row per category the backend can actually generate alerts for (see
 *  `NotificationsService.collectOperationalNotifications` for the branch-scoped operational
 *  categories, and `notifyByPermission`'s call sites in admin-users/roles-admin/tenant/
 *  tenant-settings services for the tenant-wide admin ones) — each is gated behind the same
 *  permission the API checks before generating that category, so a role only ever sees a
 *  toggle for something it could realistically receive. `salesEnabled` exists on the
 *  preferences record for a future category but has no generator yet, so it's left out here
 *  rather than showing a toggle that does nothing. */
export const NOTIFICATION_PREFERENCE_ROWS: Array<{
  key: keyof NotificationPreferences;
  label: string;
  hint: string;
  permission: string;
}> = [
  {
    key: "inventoryEnabled",
    label: "Inventory",
    hint: "Low stock and stock-health warnings",
    permission: "inventory.view",
  },
  {
    key: "expiryEnabled",
    label: "Expiry",
    hint: "Near-expiry and expired batch warnings",
    permission: "inventory.view",
  },
  {
    key: "purchasingEnabled",
    label: "Purchasing",
    hint: "Approvals, overdue orders and receiving",
    permission: "purchasing.view",
  },
  {
    key: "transfersEnabled",
    label: "Transfers",
    hint: "Approvals and incoming stock",
    permission: "transfers.view",
  },
  {
    key: "stocktakesEnabled",
    label: "Stocktakes",
    hint: "Reviews, approvals and posting",
    permission: "stocktakes.use",
  },
  {
    key: "complianceEnabled",
    label: "Access & Approvals",
    hint: "Staff and role/permission changes",
    permission: "users.view",
  },
  {
    key: "systemEnabled",
    label: "Branch & Tenant",
    hint: "Branch and tenant-wide settings changes",
    permission: "tenant.management",
  },
];

/** The preference keys a person with these permissions sees a toggle for. */
export function notificationKeysFor(
  permissionKeys: readonly string[],
): (keyof NotificationPreferences)[] {
  return NOTIFICATION_PREFERENCE_ROWS.filter((row) => permissionKeys.includes(row.permission)).map(
    (row) => row.key,
  );
}
