import type { PaymentMethod, PosMode } from "./types";

export const POS_MODES: { value: PosMode; label: string; hint: string }[] = [
  { value: "retail", label: "Retail Sale", hint: "Walk-in over-the-counter sale" },
  { value: "prescription", label: "Prescriptions", hint: "Dispense against a doctor's Rx" },
  { value: "returns", label: "Returns", hint: "Look up an invoice to refund or return" },
];

export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "mobile_wallet", label: "Mobile Wallet" },
];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  mobile_wallet: "Mobile Wallet",
};

/** Cash-drawer style denominations for one-tap exact tender. */
export const QUICK_CASH_AMOUNTS = [100, 500, 1000, 5000];

export const SHORTCUTS: { keys: string; action: string; group: string }[] = [
  { keys: "/", action: "Focus barcode / product search", group: "Scanning" },
  { keys: "F3", action: "Price check (no cart change)", group: "Scanning" },
  { keys: "Enter", action: "Add exact barcode match to cart", group: "Scanning" },
  { keys: "↑ ↓", action: "Move through search results", group: "Scanning" },
  { keys: "F4", action: "Complete sale", group: "Sale" },
  { keys: "F6", action: "Hold (park) current sale", group: "Sale" },
  { keys: "F7", action: "Recall a parked sale", group: "Sale" },
  { keys: "F8", action: "Start a new sale", group: "Sale" },
  { keys: "F9", action: "Cycle payment method", group: "Sale" },
  { keys: "Alt + C", action: "Customer lookup", group: "Sale" },
  { keys: "Alt + R", action: "Link prescription", group: "Sale" },
  { keys: "Alt + X", action: "Clear the cart", group: "Sale" },
  { keys: "Esc", action: "Close overlay / return focus to search", group: "General" },
  { keys: "?", action: "Show this shortcut sheet", group: "General" },
  { keys: "Ctrl + Shift + P", action: "Jump to POS from anywhere", group: "General" },
];

export const QUICK_ADD_TABS = [
  { value: "top", label: "Top Products" },
  { value: "frequent", label: "Frequent Items" },
  { value: "category", label: "Category" },
  { value: "recent", label: "Recent Sales" },
  { value: "suggested", label: "Suggested for this Sale" },
] as const;

export type QuickAddTab = (typeof QUICK_ADD_TABS)[number]["value"];

/** Max rows rendered in the search dropdown before the cashier should refine the term. */
export const SEARCH_RESULT_LIMIT = 8;

export const CURRENCY = "LKR";
