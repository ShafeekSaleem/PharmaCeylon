/** What the supplier ledger API returns — invoices, payments, debit notes. Money is decimal strings. */

export type InvoiceStatus = "open" | "partial" | "paid" | "voided";
export type InvoiceSource = "system" | "supplier";
export type SupplierPaymentMethod = "bank_transfer" | "cheque" | "cash" | "card" | "other";

export const PAYMENT_METHOD_OPTIONS: Array<{ value: SupplierPaymentMethod; label: string }> = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_OPTIONS.find((o) => o.value === method)?.label ?? method;
}

export type SupplierRef = { id: string; code: string; name: string };

export type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  /** `system` is a delivery still waiting for the supplier's real invoice. */
  source: InvoiceSource;
  supplier: SupplierRef;
  invoiceDate: string;
  dueDate: string;
  totalAmount: string;
  paidAmount: string;
  balance: string;
  status: InvoiceStatus;
  overdue: boolean;
  deliveries: Array<{ id: string; grnNumber: string }>;
};

export type MatchLineStatus =
  | "matched"
  | "billed_more_than_received"
  | "billed_less_than_received"
  | "price_differs"
  | "billed_not_received"
  | "received_not_billed";

export type MatchLine = {
  productId: string | null;
  product: string;
  orderedQty: number;
  orderedUnitCost: string | null;
  receivedQty: number;
  receivedUnitCost: string | null;
  billedQty: number;
  billedUnitCost: string | null;
  qtyDifference: number;
  priceDifference: string | null;
  valueAtStake: string;
  status: MatchLineStatus;
};

export type InvoiceDetail = {
  id: string;
  invoiceNumber: string;
  source: InvoiceSource;
  status: InvoiceStatus;
  supplier: SupplierRef & { paymentTermsDays: number };
  branch: { id: string; code: string; name: string } | null;
  invoiceDate: string;
  dueDate: string;
  subtotalAmount: string;
  taxAmount: string;
  shippingAmount: string;
  totalAmount: string;
  paidAmount: string;
  balance: string;
  notes: string | null;
  lines: Array<{
    id: string;
    product: { id: string; sku: string; name: string } | null;
    description: string | null;
    qty: number;
    unitCost: string;
    discountPercent: number;
    taxPercent: number;
    lineTotal: string;
  }>;
  deliveries: Array<{ id: string; grnNumber: string; receivedOn: string; poNumber: string }>;
  match: { lines: MatchLine[]; matched: boolean; valueAtStake: string };
  payments: Array<{
    paymentId: string;
    paymentNo: string;
    paidOn: string;
    method: SupplierPaymentMethod;
    reference: string | null;
    amount: string;
    voided: boolean;
  }>;
  debitNotes: Array<{ debitNoteId: string; debitNo: string; amount: string; voided: boolean }>;
};

export type PaymentRow = {
  id: string;
  paymentNo: string;
  supplier: SupplierRef;
  paidOn: string;
  amount: string;
  method: SupplierPaymentMethod;
  reference: string | null;
  notes: string | null;
  recordedBy: { id: string; fullName: string } | null;
  voided: boolean;
  allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: string }>;
};

export type DebitNoteRow = {
  id: string;
  debitNo: string;
  supplier: SupplierRef;
  goodsReturn: { id: string; returnNumber: string } | null;
  issuedOn: string;
  amount: string;
  appliedAmount: string;
  remaining: string;
  status: "open" | "settled" | "voided";
  reason: string | null;
  allocations: Array<{ invoiceId: string; invoiceNumber: string; amount: string }>;
};

export type UnbilledDelivery = {
  id: string;
  grnNumber: string;
  receivedOn: string;
  poNumber: string;
  supplierDeliveryNote: string | null;
  lines: Array<{
    product: { id: string; sku: string; name: string };
    qty: number;
    unitCost: string | null;
  }>;
};

export type Payables = {
  outstanding: string;
  overdue: string;
  awaitingInvoice: string;
  awaitingInvoiceCount: number;
  openCredits: string;
};

/** What a three-way match line means, in the words someone at a desk would use. */
export const MATCH_STATUS_LABEL: Record<MatchLineStatus, string> = {
  matched: "Matches",
  billed_more_than_received: "Billed for more than arrived",
  billed_less_than_received: "Billed for less than arrived",
  price_differs: "Price differs from the order",
  billed_not_received: "Billed, never received",
  received_not_billed: "Received, not billed",
};
