import {
  OFFLINE_RECEIPT_PREFIX_PATTERN,
  type OfflineReceiptNumbering,
} from "@pharmaceylon/shared";
import type { Prisma } from "@prisma/client";
import { denied } from "./terminal-wire";

type Tx = Prisma.TransactionClient;

/**
 * P4 #50, receipt numbering option A: the prefix and lowest free number a till's offline receipts
 * are numbered from, for its grant.
 *
 * The prefix is given the first time the till is granted offline selling, as the lowest unused
 * `C<n>R` at its branch, and is never changed or given to another till afterwards (the column is
 * unique per branch). The branch's tills are locked while one is chosen, so two tills granted at
 * once can't take the same one.
 *
 * The floor is one past the highest number the server has seen under the prefix: on a sale, or on
 * a journal entry still waiting for review (a manager may still record it as a sale under its
 * number). A counter that kept its store is above it anyway; a replaced or restored one starts
 * from it, so it never hands out a number the back office already holds.
 */
export async function offlineReceiptNumbering(
  tx: Tx,
  scope: { tenantId: string; branchId: string; tillId: string },
): Promise<OfflineReceiptNumbering> {
  const { tenantId, branchId, tillId } = scope;
  const prefix = await tillPrefix(tx, tenantId, branchId, tillId);
  const pattern = `^${prefix}-([0-9]{6,9})$`;
  const [row] = await tx.$queryRaw<{ highest: bigint | null }[]>`
    SELECT MAX(n) AS highest FROM (
      SELECT substring(invoice_no FROM ${pattern})::bigint AS n
        FROM sale
       WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid
         AND invoice_no LIKE ${`${prefix}-%`}
      UNION ALL
      SELECT substring(envelope -> 'payload' ->> 'receiptNumber' FROM ${pattern})::bigint AS n
        FROM offline_journal_review
       WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid
         AND envelope -> 'payload' ->> 'receiptNumber' LIKE ${`${prefix}-%`}
    ) seen`;
  const highest = row?.highest === null || row?.highest === undefined ? 0 : Number(row.highest);
  return { prefix, nextNumber: highest + 1 };
}

async function tillPrefix(tx: Tx, tenantId: string, branchId: string, tillId: string): Promise<string> {
  const till = await tx.terminalCounter.findFirst({
    where: { tenantId, branchId, tillId },
    select: { id: true, offlineReceiptPrefix: true },
  });
  if (!till) denied("GRANT_INVALID");
  if (till.offlineReceiptPrefix) return till.offlineReceiptPrefix;
  await tx.$queryRaw`SELECT id FROM terminal_counter
    WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid ORDER BY id FOR UPDATE`;
  const tills = await tx.terminalCounter.findMany({
    where: { tenantId, branchId },
    select: { id: true, offlineReceiptPrefix: true },
  });
  const mine = tills.find((t) => t.id === till.id);
  // Another grant gave it one while this one waited for the lock.
  if (mine?.offlineReceiptPrefix) return mine.offlineReceiptPrefix;
  const used = new Set(tills.map((t) => t.offlineReceiptPrefix).filter((p): p is string => p !== null));
  let n = 1;
  while (used.has(`C${n}R`)) n += 1;
  const prefix = `C${n}R`;
  if (!OFFLINE_RECEIPT_PREFIX_PATTERN.test(prefix)) denied("GRANT_INVALID");
  await tx.terminalCounter.updateMany({
    where: { tenantId, branchId, id: till.id, offlineReceiptPrefix: null },
    data: { offlineReceiptPrefix: prefix },
  });
  return prefix;
}
