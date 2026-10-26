import { PAYMENT_METHOD_LABELS } from "./constants";
import type { PaymentMethod } from "./types";

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)}, ${formatTime(iso)}`;
}

/** `2027-06-30` → `06/2027`, the way a pack prints it. */
export function formatExpiry(dateKey: string): string {
  const [year, month] = dateKey.split("-");
  return year && month ? `${month}/${year}` : "—";
}

export function paymentMethodsLabel(methods: PaymentMethod[]): string {
  if (methods.length === 0) return "—";
  return methods.map((method) => PAYMENT_METHOD_LABELS[method] ?? method).join(" + ");
}

/** `YYYY-MM-DD` for a local calendar day, `offset` days from today. */
export function localDateKey(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
