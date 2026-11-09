import type { TerminalEnrollmentOfflineBackup } from "@pharmaceylon/shared";
import { dayMonthYear } from "./format";

export function tillShortLabel(tillId: string) {
  return tillId.replace(/-/g, "").slice(0, 8);
}

/** Human till name from enrollment status; UUID prefix when the server sends null. */
export function tillDisplayName(
  counterLabel: string | null,
  tillId: string,
): string {
  return counterLabel ?? tillShortLabel(tillId);
}

/** "On the web by … · 13 Oct 2026" — no invented roles when the name is missing. */
export function formatOfflineAuthorized(
  backup: TerminalEnrollmentOfflineBackup,
  formatDate: (date: Date) => string = dayMonthYear,
): string | null {
  if (backup.authorizedAt == null) return null;
  const when = formatDate(new Date(backup.authorizedAt));
  if (backup.authorizedByFullName)
    return `On the web by ${backup.authorizedByFullName} · ${when}`;
  return `On the web · ${when}`;
}

/** "Here by … · 14 Oct 2026" — no invented names when the server omitted one. */
export function formatOfflineActivated(
  backup: TerminalEnrollmentOfflineBackup,
  formatDate: (date: Date) => string = dayMonthYear,
): string | null {
  if (backup.activatedAt == null) return null;
  const when = formatDate(new Date(backup.activatedAt));
  if (backup.activatedByFullName)
    return `Here by ${backup.activatedByFullName} · ${when}`;
  return `Here · ${when}`;
}
