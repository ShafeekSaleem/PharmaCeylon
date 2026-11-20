import { SALE_CHANNELS, type SaleChannel } from "@pharmaceylon/shared";
import type { PaymentMethod, SalesChannelChip, SalesFilters } from "./types";

export const PAGE_SIZE = 25;

export const CHANNEL_CHIP_ORDER: readonly SalesChannelChip[] = ["all", ...SALE_CHANNELS];

export const CHANNEL_LABELS: Record<SaleChannel, string> = {
  desktop_online: "Desktop",
  offline: "Offline",
  web_legacy: "Web",
  fallback: "Fallback",
};

export const DEFAULT_FILTERS: SalesFilters = {
  from: "",
  to: "",
  soldBy: "all",
  paymentMethod: "all",
  invoiceNo: "",
  receiptCounterScope: "any",
  channel: "all",
  registerId: "all",
  tillId: "all",
  shiftId: "all",
  offlineSyncState: "all",
};

export const OFFLINE_SYNC_FILTER_OPTIONS: {
  value: SalesFilters["offlineSyncState"];
  label: string;
}[] = [
  { value: "all", label: "All sync states" },
  { value: "accepted", label: "Accepted" },
  { value: "pending_stock_posting", label: "Pending stock posting" },
  { value: "held", label: "Held" },
];

/** Branch-only attribution filters to reset when the top-bar branch changes. */
export const BRANCH_SCOPED_FILTER_DEFAULTS: Pick<
  SalesFilters,
  "registerId" | "tillId" | "shiftId" | "receiptCounterScope" | "offlineSyncState"
> = {
  registerId: "all",
  tillId: "all",
  shiftId: "all",
  receiptCounterScope: "any",
  offlineSyncState: "all",
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  mobile_wallet: "Mobile wallet",
  credit: "Credit",
};

export const PAYMENT_METHOD_OPTIONS: { value: PaymentMethod | "all"; label: string }[] = [
  { value: "all", label: "All payment methods" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "mobile_wallet", label: "Mobile wallet" },
  { value: "credit", label: "Credit" },
];