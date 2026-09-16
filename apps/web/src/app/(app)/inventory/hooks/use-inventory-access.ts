"use client";

import { hasPermission, usePermissions } from "@/lib/permissions";

/**
 * What the signed-in user may do in Inventory at the selected branch, from their live permission
 * grants — the same keys the API enforces. This replaced a role list (owner/manager/clerk) that
 * ignored custom roles and disagreed with the API as soon as a tenant edited a role.
 */
export function useInventoryAccess() {
  const { permissionKeys, loading, hasLoadedOnce } = usePermissions();
  const can = (key: string) => hasPermission(permissionKeys, [key]);
  return {
    ready: hasLoadedOnce || !loading,
    /** Add units to a batch, open a new batch, confirm imported expiry dates. */
    canAdjustIn: can("inventory.manage"),
    /** Decrease stock (write-off). */
    canWriteOff: can("inventory.write_off"),
    canQuarantine: can("inventory.quarantine"),
    canRelease: can("inventory.release_quarantine"),
    canQuarantineAllExpired: can("inventory.manage_bulk"),
    canViewCost: can("inventory.view_cost"),
  };
}

export type InventoryAccess = ReturnType<typeof useInventoryAccess>;
