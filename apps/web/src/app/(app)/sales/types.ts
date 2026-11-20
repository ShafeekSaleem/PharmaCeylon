import type { SaleChannel } from "@pharmaceylon/shared";

export type SaleStatus = "posted" | "voided" | "refunded" | "partially_refunded";

export type PaymentMethod = "cash" | "card" | "mobile_wallet" | "credit";

export type SaleAttribution = {
  channel: SaleChannel;
  terminal: { id: string; label: string } | null;
  register: { id: string; tillId: string; label: string } | null;
  shift: {
    id: string;
    shiftNumber: string;
    openedAt: string;
    closedAt: string | null;
  } | null;
};

/** One row of `GET /sales/history`. */
export type SaleListRow = SaleAttribution & {
  id: string;
  invoiceNo: string;
  status: SaleStatus;
  soldAt: string;
  grandTotal: string;
  branch: { id: string; name: string };
  itemCount: number;
  customerName: string | null;
  sellerName: string;
  /** How the customer paid; refund rows are left out. */
  paymentMethods: PaymentMethod[];
  /** The first few lines, "2× Paracetamol, 1× Cetirizine". */
  summary: string;
};

export type SalesHistoryPage = {
  items: SaleListRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type SalesHistoryRegisterOption = {
  registerId: string;
  tillId: string;
  label: string;
  branchId: string;
};

export type SalesHistoryTerminalOption = {
  terminalId: string;
  label: string;
  branchId: string;
};

export type SalesHistoryOptions = {
  branches: { id: string; name: string }[];
  sellers: { id: string; fullName: string }[];
  registers: SalesHistoryRegisterOption[];
  terminals: SalesHistoryTerminalOption[];
};

/** `GET /sales/history/:id`. Costs are `null` when the caller lacks `costs.view` there. */
export type SaleDetail = SaleAttribution & {
  id: string;
  invoiceNo: string;
  status: SaleStatus;
  soldAt: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  amountPaid: string;
  changeDue: string;
  costTotal: string | null;
  notes: string | null;
  branch: { id: string; name: string };
  customer: { id: string; fullName: string; phone: string | null } | null;
  prescription: { id: string; rxNumber: string; patientName: string; doctorName: string } | null;
  seller: { id: string; fullName: string };
  dispenser: { id: string; fullName: string } | null;
  items: {
    id: string;
    qty: number;
    unitPrice: string;
    discountAmount: string;
    taxAmount: string;
    lineTotal: string;
    unitCost: string | null;
    product: { id: string; name: string; sku: string; unit: string | null };
    batch: { id: string; batchNo: string; expiryDate: string };
  }[];
  /** Refunds are negative rows referenced `POS refund <returnNumber>`. */
  payments: {
    id: string;
    method: PaymentMethod;
    amount: string;
    reference: string | null;
    createdAt: string;
  }[];
  refunds: { id: string; returnNumber: string; amount: string; createdAt: string }[];
};

export type SalesChannelChip = "all" | SaleChannel;

/**
 * Server-side filters for sales history. Branch scope comes from the top-bar switch
 * (`x-branch-id`), not from this object.
 */
export type SalesFilters = {
  from: string;
  to: string;
  soldBy: string;
  paymentMethod: PaymentMethod | "all";
  invoiceNo: string;
  /** Counter scope beside the receipt search — `any` or a register id. */
  receiptCounterScope: string;
  channel: SalesChannelChip;
  registerId: string;
  tillId: string;
  shiftId: string;
};

type Person = { id: string; fullName: string } | null;

/** A refund prepared remotely (`/sales/refund-requests`). It waits at the counter to be executed. */
export type SaleRefundRequest = {
  id: string;
  requestNumber: string;
  saleId: string;
  invoiceNo: string | null;
  status: "prepared" | "approved" | "executed" | "cancelled";
  lines: { productId: string; batchId: string; productName?: string | null; batchNo?: string | null; qty: number; unitPrice: string; disposition: "restock" | "quarantine" }[];
  amount: string;
  refundMethod: PaymentMethod | null;
  reasonCode: string | null;
  reason: string;
  /** Over the tenant's refund threshold: needs someone who approves returns. */
  approvalRequired: boolean;
  executionApprovalId: string | null;
  approvalRevoked: boolean;
  /** Nothing more is needed before the counter refunds it. */
  readyAtCounter: boolean;
  approvalReview: { expectedVersion: number; expectedDigest: string } | null;
  approvalVersion: number;
  requester: Person;
  requestedAt: string;
  approver: Person;
  approvedAt: string | null;
  executor: Person;
  executedAt: string | null;
  goodsReturnId: string | null;
  cancelledBy: Person;
  cancelledAt: string | null;
};