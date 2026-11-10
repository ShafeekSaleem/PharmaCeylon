import type { Prisma, TerminalCommandReceipt } from "@prisma/client";
import type { OfflineJournalCommand, Signed } from "@pharmaceylon/shared";

type Db = Prisma.TransactionClient;
type Scope = { tenantId: string; enrollmentId: string };

/** Receipts for accepted offline journal commands carry this operation prefix. */
export const OFFLINE_JOURNAL_OPERATION = "offline_journal:";

/**
 * Every writer of an enrollment's journal chain queues here, in its own transaction: intake of
 * each uploaded command, and a manager's settlement of a refused one (P5 slice 4). Concurrent
 * identical retries serialize, and the second finds the first's receipt.
 */
export async function lockOfflineJournal(tx: Db, scope: Scope): Promise<void> {
  const lockKey = `offline-journal:${scope.tenantId}:${scope.enrollmentId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

/**
 * The till rows an entry's effect touches, locked as intake locks them, so a manager's settlement
 * (P5 slice 4) checks and writes against one state. A sale share-locks its shift, so the shift can't
 * close underneath it (an online close takes it FOR UPDATE). A shift open or close locks the till's
 * counter, so opens and closes on that till serialize with online ones, and a close locks its shift
 * too. Taken after the journal lock, in intake's order (counter, then shift).
 */
export async function lockTillForEntry(
  tx: Db,
  scope: { tenantId: string; branchId: string },
  command: OfflineJournalCommand,
): Promise<void> {
  const { tenantId, branchId } = scope;
  const { registerId, workSessionId } = command.session;
  if (command.kind === "ordinary_sale") {
    await tx.$queryRaw`SELECT id FROM till_shift WHERE tenant_id = ${tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${workSessionId}::uuid FOR SHARE`;
    return;
  }
  await tx.$queryRaw`SELECT id FROM terminal_counter WHERE tenant_id = ${tenantId}::uuid
    AND branch_id = ${branchId}::uuid AND id = ${registerId}::uuid FOR UPDATE`;
  if (command.kind === "shift_close")
    await tx.$queryRaw`SELECT id FROM till_shift WHERE tenant_id = ${tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${workSessionId}::uuid FOR UPDATE`;
}

/** The highest accepted command; sequences are accepted only contiguously from 1. */
export function offlineJournalHead(
  client: Pick<Db, "terminalCommandReceipt">,
  scope: Scope,
) {
  return client.terminalCommandReceipt.findFirst({
    where: {
      tenantId: scope.tenantId,
      enrollmentId: scope.enrollmentId,
      offlineSequence: { not: null },
    },
    orderBy: { offlineSequence: "desc" },
  });
}

export function storedCommand(
  receipt: Pick<TerminalCommandReceipt, "command">,
): OfflineJournalCommand | null {
  const envelope =
    receipt.command as unknown as Signed<OfflineJournalCommand> | null;
  return envelope && typeof envelope === "object" && envelope.payload
    ? envelope.payload
    : null;
}

/** Whether a receipt is a manager's settlement of a refused entry (slice 4), not intake's. */
export function isReviewedReceipt(
  receipt: Pick<TerminalCommandReceipt, "result">,
): boolean {
  const result = receipt.result;
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    "review" in result
  );
}
