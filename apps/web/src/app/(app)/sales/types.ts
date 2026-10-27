export type SaleStatus = "posted" | "voided" | "refunded" | "partially_refunded";

export type PaymentMethod = "cash" | "card" | "mobile_wallet" | "credit";

/** One row of `GET /sales/history`. */
export type SaleListRow = {
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

export type SalesHistoryOptions = {
  branches: { id: string; name: string }[];
  sellers: { id: string; fullName: string }[];
};

/** `GET /sales/history/:id`. Costs are `null` when the caller lacks `costs.view` there. */
export type SaleDetail = {
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

/**
 * `branch` is `current` (follow the branch picked in the top bar), `all` (every branch the
 * caller can view), or one branch id.
 */
export type SalesFilters = {
  branch: string;
  from: string;
  to: string;
  soldBy: string;
  paymentMethod: PaymentMethod | "all";
  invoiceNo: string;
};
