import { apiJson } from "@/lib/auth-client";
import type {
  CheckoutPayload,
  Customer,
  HeldSaleDetail,
  HeldSalePayload,
  HeldSaleSummary,
  PosCatalog,
  Prescription,
  RecentSale,
  SaleReceipt,
} from "../types";

const jsonHeaders = { "Content-Type": "application/json" };

export function fetchPosCatalog(): Promise<PosCatalog> {
  return apiJson<PosCatalog>("/sales/pos/catalog");
}

export function fetchRecentSales(take = 12): Promise<RecentSale[]> {
  return apiJson<RecentSale[]>(`/sales/pos/recent?take=${take}`);
}

export function findSaleByInvoice(invoiceNo: string): Promise<SaleReceipt> {
  return apiJson<SaleReceipt>(
    `/sales/pos/by-invoice?invoiceNo=${encodeURIComponent(invoiceNo)}`,
  );
}

export type InvoiceSearchHit = {
  id: string;
  invoiceNo: string;
  status: "posted" | "voided" | "refunded" | "partially_refunded";
  soldAt: string;
  grandTotal: string;
  customer: { fullName: string; phone: string | null } | null;
  _count: { items: number };
};

export function searchInvoices(q: string, take = 12): Promise<InvoiceSearchHit[]> {
  const term = q.trim();
  if (!term) return Promise.resolve([]);
  return apiJson<InvoiceSearchHit[]>(
    `/sales/pos/search-invoices?q=${encodeURIComponent(term)}&take=${take}`,
  );
}

export type SaleReturnableLine = {
  saleItemId: string;
  productId: string;
  batchId: string;
  productName: string;
  sku: string;
  isControlled: boolean;
  batchNo: string;
  soldQty: number;
  remainingQty: number;
  /** Catalog / list unit price (may differ from what the customer paid). */
  unitPrice: string;
  /** Paid amount attributable to remaining qty (after discount/VAT share). */
  lineTotal: string;
  /** Effective refund price per remaining unit (lineTotal ÷ remainingQty). */
  refundUnitPrice: string;
};

export type SaleReturnable = {
  saleId: string;
  invoiceNo: string;
  status: SaleReceipt["status"];
  requiresPharmacist: boolean;
  lines: SaleReturnableLine[];
  totalRemainingQty: number;
};

export function fetchSaleReturnable(saleId: string): Promise<SaleReturnable> {
  return apiJson<SaleReturnable>(`/sales/${saleId}/returnable`);
}

export type RefundSalePayload = {
  reason: string;
  items?: { productId: string; batchId: string; qty: number }[];
  refundMethod?: "cash" | "card" | "mobile_wallet";
  refundAmount?: string;
};

export function refundSale(saleId: string, payload: RefundSalePayload): Promise<SaleReceipt> {
  return apiJson<SaleReceipt>(`/sales/${saleId}/refund`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
}

export function searchCustomers(q: string): Promise<Customer[]> {
  const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return apiJson<Customer[]>(`/customers${qs}`);
}

export function getCustomer(id: string): Promise<Customer> {
  return apiJson<Customer>(`/customers/${id}`);
}

export function createCustomer(input: {
  fullName: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}): Promise<Customer> {
  return apiJson<Customer>("/customers", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

export function searchPrescriptions(q: string): Promise<Prescription[]> {
  const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return apiJson<Prescription[]>(`/prescriptions${qs}`);
}

export function getPrescription(id: string): Promise<Prescription> {
  return apiJson<Prescription>(`/prescriptions/${id}`);
}

export function createPrescription(input: {
  patientName: string;
  doctorName: string;
  doctorRegNo?: string;
  issuedOn: string;
  validUntil?: string;
  customerId?: string;
  notes?: string;
}): Promise<Prescription> {
  return apiJson<Prescription>("/prescriptions", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

export function listHolds(): Promise<HeldSaleSummary[]> {
  return apiJson<HeldSaleSummary[]>("/sales/holds");
}

export function getHold(id: string): Promise<HeldSaleDetail> {
  return apiJson<HeldSaleDetail>(`/sales/holds/${id}`);
}

/** Recalling a hold consumes it server-side — it can never be recalled twice. */
export function recallHold(id: string): Promise<HeldSaleDetail> {
  return apiJson<HeldSaleDetail>(`/sales/holds/${id}/recall`, { method: "POST" });
}

export function createHold(input: {
  label?: string;
  itemCount: number;
  total: string;
  lines: HeldSalePayload["lines"];
  meta: HeldSalePayload["meta"];
}): Promise<{ id: string; holdRef: string; createdAt: string }> {
  return apiJson("/sales/holds", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

export function discardHold(id: string): Promise<{ id: string; discarded: boolean }> {
  return apiJson(`/sales/holds/${id}`, { method: "DELETE" });
}

export function checkout(
  payload: CheckoutPayload,
  idempotencyKey: string,
): Promise<SaleReceipt> {
  return apiJson<SaleReceipt>("/sales/checkout", {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload),
  });
}

export type PosApprover = {
  id: string;
  fullName: string;
  email: string;
  hasPosPin: boolean;
  roles: string[];
};

export function listPosApprovers(): Promise<PosApprover[]> {
  return apiJson<PosApprover[]>("/sales/pos/approvers");
}

export function setMyPosPin(pin: string, password: string): Promise<{ set: boolean }> {
  return apiJson("/sales/pos/me/pos-pin", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ pin, password }),
  });
}
