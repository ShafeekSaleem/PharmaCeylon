import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { JournalPosition } from "@pharmaceylon/shared";

type Tx = Prisma.TransactionClient;
type Scope = Readonly<{
  tenantId: string;
  branchId: string;
  enrollmentId: string;
}>;

export const RESTORED_COUNTER_WAIT = "RESTORED_COUNTER_WAIT";

/**
 * P5 #51, D11: what a restored counter's journal recovery means for issuing offline authority to
 * its enrollment. Read on the issuance's (or its challenge's) own transaction.
 *
 * **An open recovery holds issuance** while it still describes the journal: reported or
 * approved against the accepted head as it is now. The counter has not set its unmatched
 * entries aside or dropped its restored grant yet. One reported against an older head can never
 * complete (the counter is told to report again), so it is superseded here instead of refusing
 * for good: a computer that was wiped or restored again never asks about it.
 */
export async function restoreRecoveryHolds(
  tx: Tx,
  scope: Scope,
  head: JournalPosition,
): Promise<boolean> {
  const open = await tx.offlineJournalRecovery.findMany({
    where: {
      tenantId: scope.tenantId,
      enrollmentId: scope.enrollmentId,
      kind: "counter_restore",
      status: { in: ["awaiting_approval", "approved"] },
    },
    select: { id: true, serverHeadSequence: true, serverHeadHash: true },
  });
  let holds = false;
  for (const row of open) {
    if (
      Number(row.serverHeadSequence) === head.sequence &&
      row.serverHeadHash === head.hash
    ) {
      holds = true;
      continue;
    }
    // The head only moves forward, so a recovery stale in this view stays stale.
    await tx.offlineJournalRecovery.updateMany({
      where: {
        id: row.id,
        tenantId: scope.tenantId,
        status: { in: ["awaiting_approval", "approved"] },
      },
      data: { status: "superseded", supersededAt: new Date() },
    });
  }
  return holds;
}

/**
 * **After a restore, wait out the last grant** (D11, decisions of 2026-11-10). A restored copy
 * and the computer it was copied from share one enrollment, and only the restored copy dropped
 * its grant: the original may be offline but still selling on a grant it holds. So once a
 * restore was approved and finished — completed, or closed after approval, when the copy may have
 * applied it — nothing is issued to the enrollment until every grant issued before the restore
 * finished has expired. Online selling is unaffected.
 *
 * Returns when issuance may resume, or null when nothing waits now.
 */
export async function restoredCounterResumesAt(
  tx: Tx,
  scope: Scope,
  now: number,
): Promise<number | null> {
  const restores = await tx.offlineJournalRecovery.findMany({
    where: {
      tenantId: scope.tenantId,
      enrollmentId: scope.enrollmentId,
      kind: "counter_restore",
      status: { in: ["recovered", "closed"] },
      approvedAt: { not: null },
    },
    select: { completedAt: true, closedAt: true },
  });
  const ends = restores
    .map((r) => (r.completedAt ?? r.closedAt)?.getTime())
    .filter((t): t is number => t !== undefined);
  if (!ends.length) return null;
  const finished = Math.max(...ends);
  const [{ latest }] = await tx.$queryRaw<{ latest: bigint | null }[]>`
    SELECT max(("grant" -> 'payload' ->> 'expiresAt')::bigint) AS latest
    FROM offline_authority_issuance
    WHERE tenant_id = ${scope.tenantId}::uuid AND branch_id = ${scope.branchId}::uuid
      AND enrollment_id = ${scope.enrollmentId}::uuid
      AND ("grant" -> 'payload' ->> 'issuedAt')::bigint < ${BigInt(finished)}::bigint`;
  const expiresAt = latest === null ? null : Number(latest);
  return expiresAt !== null && now < expiresAt ? expiresAt : null;
}

/** Refuses issuance while a restored counter waits out its last grant (`RESTORED_COUNTER_WAIT`). */
export async function refuseWhileRestoredCounterWaits(
  tx: Tx,
  scope: Scope,
  now: number,
): Promise<void> {
  const availableAt = await restoredCounterResumesAt(tx, scope, now);
  if (availableAt !== null)
    throw new ForbiddenException({
      code: RESTORED_COUNTER_WAIT,
      message:
        "This counter was restored from an older copy. It can sell offline again once the offline permission issued before the restore has expired; online selling works meanwhile.",
      availableAt,
    });
}
