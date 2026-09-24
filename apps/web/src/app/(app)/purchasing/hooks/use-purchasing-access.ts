"use client";

import { hasPermission, usePermissions } from "@/lib/permissions";

/**
 * What the signed-in user may do in Purchasing at the selected branch, from their live permission
 * grants — the same keys the API enforces.
 *
 * This replaced a hardcoded role list (owner/manager/clerk), which ignored custom roles and went
 * out of step with the API the moment a tenant edited one. Receiving and seeing costs are their
 * own keys now: a storekeeper books deliveries in without being able to price an order, and a
 * pharmacist can be given the order list without the money on it.
 */
export function usePurchasingAccess() {
  const { permissionKeys, loading, hasLoadedOnce } = usePermissions();
  const can = (key: string) => hasPermission(permissionKeys, [key]);
  return {
    ready: hasLoadedOnce || !loading,
    /** Raise, edit and issue purchase orders. */
    canManage: can("purchasing.manage"),
    /** Book a delivery in against an order. */
    canReceive: can("purchasing.receive"),
    /** Approve, reject, short-close or cancel — and accept an over-delivery. */
    canApprove: can("purchasing.approve"),
    /** See unit costs, order values and supplier price lists. */
    canViewCost: can("purchasing.view_cost"),
    /** Edit supplier records, invoices and payments. */
    canManageSuppliers: can("suppliers.manage"),
    /** See and change what a supplier charges — a commercial decision, not a stock one. */
    canManagePrices: can("suppliers.manage_prices"),
    /** Record the supplier's own invoice, match it to deliveries, raise and void debit notes. */
    canInvoice: can("purchasing.invoice"),
    /** Record money paid to a supplier and apply debit notes. */
    canPay: can("suppliers.pay"),
    /** Supplier returns: sending stock back and the debit note that follows. */
    canViewReturns: can("returns.view"),
  };
}

export type PurchasingAccess = ReturnType<typeof usePurchasingAccess>;
