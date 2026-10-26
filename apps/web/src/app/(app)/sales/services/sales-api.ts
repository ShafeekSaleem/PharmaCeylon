import { apiJson } from "@/lib/auth-client";
import { PAGE_SIZE } from "../constants";
import type { SaleDetail, SalesFilters, SalesHistoryOptions, SalesHistoryPage } from "../types";

export function salesHistoryQuery(filters: SalesFilters, page: number): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  // `current` sends nothing: the API reads the branch picked in the top bar.
  if (filters.branch !== "current") params.set("branchId", filters.branch);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.soldBy !== "all") params.set("soldBy", filters.soldBy);
  if (filters.paymentMethod !== "all") params.set("paymentMethod", filters.paymentMethod);
  const invoiceNo = filters.invoiceNo.trim();
  if (invoiceNo) params.set("invoiceNo", invoiceNo);
  return params.toString();
}

export function fetchSalesHistory(filters: SalesFilters, page: number): Promise<SalesHistoryPage> {
  return apiJson<SalesHistoryPage>(`/sales/history?${salesHistoryQuery(filters, page)}`);
}

export function fetchSalesHistoryOptions(): Promise<SalesHistoryOptions> {
  return apiJson<SalesHistoryOptions>("/sales/history/options");
}

export function fetchSaleDetail(id: string): Promise<SaleDetail> {
  return apiJson<SaleDetail>(`/sales/history/${encodeURIComponent(id)}`);
}
