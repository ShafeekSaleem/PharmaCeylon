import { SALE_CHANNELS } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { PAGE_SIZE } from "../constants";
import type {
  CollectedMoneyRow,
  PaymentRecoveryRow,
  SaleDetail,
  SaleIncidentNoteRow,
  SalesChannelChip,
  SalesFilters,
  SalesHistoryOptions,
  SalesHistoryPage,
  SalesQueuePage,
} from "../types";

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
  if (filters.offlineSyncState !== "all") {
    params.set("offlineSyncState", filters.offlineSyncState);
  }
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
    offlineSyncStates: options.offlineSyncStates ?? [],
  }));
}

export type IncidentNotesQueueStatus = "open" | "held";

export function fetchIncidentNotes(
  page: number,
  pageSize = PAGE_SIZE,
  status: IncidentNotesQueueStatus = "open",
  sort: "recordedAt" | "receivedAt" = "recordedAt",
): Promise<SalesQueuePage<SaleIncidentNoteRow>> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    status,
    sort,
  });
  return apiJson(`/sales/incident-notes?${params}`);
}

export function fetchIncidentNotesTotal(
  status: IncidentNotesQueueStatus = "open",
): Promise<number> {
  const params = new URLSearchParams({ page: "1", pageSize: "1", status });
  return apiJson<SalesQueuePage<SaleIncidentNoteRow>>(`/sales/incident-notes?${params}`).then((p) => p.total);
}

export function fetchPaymentRecovery(page: number, pageSize = PAGE_SIZE): Promise<SalesQueuePage<PaymentRecoveryRow>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiJson(`/sales/payment-recovery?${params}`);
}

export function fetchPaymentRecoveryTotal(): Promise<number> {
  const params = new URLSearchParams({ page: "1", pageSize: "1" });
  return apiJson<SalesQueuePage<PaymentRecoveryRow>>(`/sales/payment-recovery?${params}`).then((p) => p.total);
}

export function fetchCollectedMoney(page: number, pageSize = PAGE_SIZE): Promise<SalesQueuePage<CollectedMoneyRow>> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiJson(`/sales/collected-money?${params}`);
}

export function fetchCollectedMoneyTotal(): Promise<number> {
  const params = new URLSearchParams({ page: "1", pageSize: "1" });
  return apiJson<SalesQueuePage<CollectedMoneyRow>>(`/sales/collected-money?${params}`).then((p) => p.total);
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