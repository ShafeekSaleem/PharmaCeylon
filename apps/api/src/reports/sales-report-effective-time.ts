import type { OfflineJournalCommand, OfflineSaleCommand, Signed } from "@pharmaceylon/shared";

/** Counter `occurredAt` from a stored journal command envelope, when present. */
export function offlineCommandOccurredAt(command: unknown): number | null {
  if (!command || typeof command !== "object") return null;
  const signed = command as Signed<OfflineJournalCommand>;
  const payload: OfflineJournalCommand =
    "payload" in signed && signed.payload ? signed.payload : (command as OfflineJournalCommand);
  if (payload.kind !== "ordinary_sale") return null;
  const occurredAt = (payload as OfflineSaleCommand).occurredAt;
  return typeof occurredAt === "number" && Number.isFinite(occurredAt) ? occurredAt : null;
}

export type SaleInstantRow = Readonly<{
  soldAt: Date;
  offlineCommandId: string | null;
}>;

/** When the sale replayed from the offline journal, the counter's occurred time wins over soldAt. */
export function effectiveSaleInstant(
  sale: SaleInstantRow,
  occurredAtByCommandId: ReadonlyMap<string, number>,
): Date {
  if (sale.offlineCommandId) {
    const ms = occurredAtByCommandId.get(sale.offlineCommandId);
    if (ms != null) return new Date(ms);
  }
  return sale.soldAt;
}