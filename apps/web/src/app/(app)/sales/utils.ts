import type { SaleChannel } from "@pharmaceylon/shared";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";

const BUSINESS_TIME_ZONE = "Asia/Colombo";
import { CHANNEL_LABELS } from "./constants";
import { PAYMENT_METHOD_LABELS } from "./constants";
import type { PaymentMethod, SaleListRow } from "./types";

export function channelLabel(channel: SaleChannel): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

export const DASH = "—";

export function tillLabelFromRegister(register: SaleListRow["register"]): string {
  if (!register) return DASH;
  const digits = register.label.replace(/\D/g, "");
  return digits ? `Till ${digits}` : register.label;
}

export function formatShiftRange(shift: NonNullable<SaleListRow["shift"]>): string {
  const opened = formatTime(shift.openedAt);
  const closed = shift.closedAt ? formatTime(shift.closedAt) : "open";
  return `${opened}–${closed}`;
}

export function formatShiftDetail(shift: NonNullable<SaleListRow["shift"]>): string {
  const started = new Date(shift.openedAt).toLocaleString(DISPLAY_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
  if (!shift.closedAt) {
    return `Started ${started} ${BUSINESS_TIME_ZONE} · still open`;
  }
  const ended = new Date(shift.closedAt).toLocaleString(DISPLAY_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BUSINESS_TIME_ZONE,
  });
  return `Started ${started} ${BUSINESS_TIME_ZONE} · closed ${ended}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(DISPLAY_LOCALE, { day: "numeric", month: "short", year: "numeric" });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(DISPLAY_LOCALE, { hour: "2-digit", minute: "2-digit" });
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
