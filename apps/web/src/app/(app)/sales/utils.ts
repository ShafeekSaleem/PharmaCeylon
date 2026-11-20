import type { SaleChannel } from "@pharmaceylon/shared";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";
import { CHANNEL_LABELS } from "./constants";
import { PAYMENT_METHOD_LABELS } from "./constants";
import type { PaymentMethod, SaleListRow } from "./types";

export const BUSINESS_TIME_ZONE = "Asia/Colombo";

export function channelLabel(channel: SaleChannel): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

export const DASH = "—";

type DateTimeOpts = { timeZone?: string };

export function formatDate(iso: string, { timeZone = BUSINESS_TIME_ZONE }: DateTimeOpts = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleDateString(DISPLAY_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  });
}

export function formatTime(iso: string, { timeZone = BUSINESS_TIME_ZONE }: DateTimeOpts = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleTimeString(DISPLAY_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
}

export function formatDateTime(iso: string, opts?: DateTimeOpts): string {
  return `${formatDate(iso, opts)}, ${formatTime(iso, opts)}`;
}

export function formatShiftRange(shift: NonNullable<SaleListRow["shift"]>): string {
  const opened = formatTime(shift.openedAt);
  const closed = shift.closedAt ? formatTime(shift.closedAt) : "open";
  return `${opened}–${closed}`;
}

export function formatShiftDetail(shift: NonNullable<SaleListRow["shift"]>): string {
  const started = formatDateTime(shift.openedAt);
  if (!shift.closedAt) {
    return `Started ${started} ${BUSINESS_TIME_ZONE} · still open`;
  }
  return `Started ${started} ${BUSINESS_TIME_ZONE} · closed ${formatDateTime(shift.closedAt)}`;
}

/** `2027-06-30` → `06/2027`, the way a pack prints it. */
export function formatExpiry(dateKey: string): string {
  const [year, month] = dateKey.split("-");
  return year && month ? `${month}/${year}` : DASH;
}

export function paymentMethodsLabel(methods: PaymentMethod[]): string {
  if (methods.length === 0) return DASH;
  return methods.map((method) => PAYMENT_METHOD_LABELS[method] ?? method).join(" + ");
}

/** `YYYY-MM-DD` for a local calendar day, `offset` days from today. */
export function localDateKey(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}