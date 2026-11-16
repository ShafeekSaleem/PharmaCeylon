export const SUPPLIER_CASH_PAYOUT_STATUSES = [
  "prepared",
  "approved",
  "executed",
  "cancelled",
] as const;
export type SupplierCashPayoutStatus = (typeof SUPPLIER_CASH_PAYOUT_STATUSES)[number];

export type SupplierCashPayoutAllocation = Readonly<{
  invoiceId: string;
  amount: string;
}>;

export type SupplierCashPayoutPerson = Readonly<{ id: string; fullName: string }> | null;

/** List/detail view from GET/POST `/purchasing/cash-payouts` (PR #181). */
export type SupplierCashPayoutView = Readonly<{
  id: string;
  payoutNumber: string;
  status: SupplierCashPayoutStatus;
  supplier: Readonly<{ id: string; code: string; name: string }> | null;
  purchaseOrder: Readonly<{ id: string; poNumber: string }> | null;
  amount: string;
  paidOn: string;
  reference: string | null;
  notes: string | null;
  allocations: ReadonlyArray<SupplierCashPayoutAllocation>;
  executionApprovalId: string | null;
  approvalRevoked: boolean;
  readyAtCounter: boolean;
  approvalReview: Readonly<{ expectedVersion: number; expectedDigest: string }> | null;
  approvalVersion: number;
  requester: SupplierCashPayoutPerson;
  requestedAt: string;
  approver: SupplierCashPayoutPerson;
  approvedAt: string | null;
  executor: SupplierCashPayoutPerson;
  executedAt: string | null;
  supplierPaymentId: string | null;
  cancelledBy: SupplierCashPayoutPerson;
  cancelledAt: string | null;
}>;

/** Counter list row (`GET ?readyAtCounter=true`), aligned with the web detail fields the UI needs. */
export type SupplierCashPayoutAtCounter = Readonly<{
  cashPayoutId: string;
  payoutNumber: string;
  supplierName: string | null;
  purchaseOrderNumber: string | null;
  amount: string;
  paidOn: string;
  reference: string | null;
  notes: string | null;
  allocations: ReadonlyArray<SupplierCashPayoutAllocation>;
  executionApprovalId: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
}>;

export type SupplierCashPayoutExecuted = Readonly<{
  payoutNumber: string;
  amountMinor: number;
  supplierPaymentId: string;
  alreadyApplied: boolean;
  requestedBy: string | null;
  approvedBy: string | null;
  movementReason: string;
}>;