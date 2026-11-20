import { SALE_CHANNELS } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { PAGE_SIZE } from "../constants";
import type { SaleDetail, SalesChannelChip, SalesFilters, SalesHistoryOptions, SalesHistoryPage } from "../types";

function counterScopeRegisterId(filters: SalesFilters): string | undefined {
  const invoice = filters.invoiceNo.trim();
  if (!invoice) return undefined;
  if (filters.registerId !== "all") return filters.registerId;
  if (filters.receiptCounterScope !== "any") return filters.receiptCounterScope;
  return undefined;
}

/** Maps UI filters to `GET /sales/history` query params (PR #242). */
export function salesHistoryQuery(filters: SalesFilters, page: number): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.soldBy !== "all") params.set("soldBy", filters.soldBy);
  if (filters.paymentMethod !== "all") params.set("paymentMethod", filters.paymentMethod);
  const invoiceNo = filters.invoiceNo.trim();
  if (invoiceNo) params.set("invoiceNo", invoiceNo);
  if (filters.channel !== "all") params.set("channel", filters.channel);
  const scopedRegister = counterScopeRegisterId(filters);
  const registerFilter = filters.registerId !== "all" ? filters.registerId : scopedRegister;
  if (registerFilter) params.set("registerId", registerFilter);
  if (filters.tillId !== "all") params.set("tillId", filters.tillId);
  if (filters.shiftId !== "all") params.set("shiftId", filters.shiftId);
  return params.toString();
}

export function fetchSalesHistory(filters: SalesFilters, page: number): Promise<SalesHistoryPage> {
  return apiJson<SalesHistoryPage>(`/sales/history?${salesHistoryQuery(filters, page)}`);
}

export function fetchSalesHistoryTotal(filters: SalesFilters, channel: SalesChannelChip): Promise<number> {
  const withChannel: SalesFilters = channel === "all" ? filters : { ...filters, channel };
  const params = new URLSearchParams(salesHistoryQuery(withChannel, 1));
  params.set("pageSize", "1");
  return apiJson<SalesHistoryPage>(`/sales/history?${params.toString()}`).then((page) => page.total);
}

export function fetchSalesHistoryOptions(): Promise<SalesHistoryOptions> {
  return apiJson<SalesHistoryOptions>("/sales/history/options").then((options) => ({
    branches: options.branches ?? [],
    sellers: options.sellers ?? [],
    registers: options.registers ?? [],
    terminals: options.terminals ?? [],
    shifts: options.shifts ?? [],
  }));
}

export function fetchSaleDetail(id: string): Promise<SaleDetail> {
  return apiJson<SaleDetail>(`/sales/history/${encodeURIComponent(id)}`);
}

export type SaleChannelCounts = Record<SalesChannelChip, number | null>;

export function fetchSalesChannelCounts(filters: SalesFilters): Promise<SaleChannelCounts> {
  const base: SalesFilters = { ...filters, channel: "all" };
  const chips: SalesChannelChip[] = ["all", ...SALE_CHANNELS];
  return Promise.all(
    chips.map(async (chip) => {
      try {
        return [chip, await fetchSalesHistoryTotal(base, chip)] as const;
      } catch {
        return [chip, null] as const;
      }
    }),
  ).then((entries) => Object.fromEntries(entries) as SaleChannelCounts);
}