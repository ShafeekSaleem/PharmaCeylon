import type { PaymentMethod, SalesFilters } from "./types";

export const PAGE_SIZE = 25;

export const DEFAULT_FILTERS: SalesFilters = {
  branch: "current",
  from: "",
  to: "",
  soldBy: "all",
  paymentMethod: "all",
  invoiceNo: "",
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
