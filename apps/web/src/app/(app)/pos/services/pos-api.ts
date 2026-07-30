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

export function refundSale(saleId: string, reason: string): Promise<SaleReceipt> {
  return apiJson<SaleReceipt>(`/sales/${saleId}/refund`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ reason }),
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
