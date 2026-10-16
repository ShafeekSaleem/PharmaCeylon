import type { PaymentMethod } from "./types";

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
  { keys: "F2 / Alt + C", action: "Customer lookup", group: "Sale" },
  { keys: "Alt + R", action: "Link prescription", group: "Sale" },
  { keys: "Alt + X", action: "Clear the cart", group: "Sale" },
  { keys: "Alt + F", action: "Toggle focus mode (hide sidebar/topbar)", group: "General" },
  { keys: "Esc", action: "Close overlay / return focus to search", group: "General" },
  { keys: "?", action: "Show this shortcut sheet", group: "General" },
  { keys: "Ctrl + Shift + P", action: "Jump to POS from anywhere", group: "General" },
  { keys: "Ctrl + Shift + F", action: "Toggle fullscreen (any page)", group: "General" },
];

/** Max rows rendered in the search dropdown before the cashier should refine the term. */
export const SEARCH_RESULT_LIMIT = 8;

export const CURRENCY = "LKR";
