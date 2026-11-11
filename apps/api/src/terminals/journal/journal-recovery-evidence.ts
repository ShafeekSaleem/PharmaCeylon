import type { Prisma } from "@prisma/client";
import type { JournalPosition } from "@pharmaceylon/shared";
import type { AuthorityCutoff } from "../grant-cutoff";
import { acceptedJournalHead } from "../offline-authority-issuance";
import { lockEnrollmentJournal } from "./journal-uploader";

type Tx = Prisma.TransactionClient;

/**
 * P5 #51, approved D11, the journal half of replacing the branch's offline counter (decisions of
 * 2026-11-10): the owner or a delegated manager signs off the old counter's journal — what the
 * server accepted, and that anything it never received is reviewed as lost.
 *
 * - **Waiting.** A sign-off is possible only once the last grant issued to that enrollment has
 *   expired, even when the enrollment was revoked or its terminal retired: a revoked flag on the
 *   server does not stop a disconnected device selling on the grant it holds, so before then the
 *   journal could still grow.
 * - **Always a person.** There is no automatic clearance from complete-looking evidence, not
 *   even for an enrollment that was never issued a grant (its sign-off is available at once).
 *
 * A sign-off covers exactly what it saw: the nomination version, the accepted head, the latest
 * grant, and the evidence held for the enrollment past its head (`evidenceMark`). A revoked or
 * retired counter's head is frozen (its uploads are held, never accepted), so what it uploads
 * later shows up only as new retained refusals; a restored copy's report is a new recovery. Any
 * of these — or a re-nomination, or a grant issued afterwards — makes the sign-off stale.
 */
/** When a sign-off becomes possible; null when it is possible now (no grant was ever issued). */
export function signOffAvailableAt(cutoff: AuthorityCutoff): number | null {
  return cutoff.lastGrantExpiresAt;
}

export function maySignOff(cutoff: AuthorityCutoff, now: number): boolean {
  const at = signOffAvailableAt(cutoff);
  return at === null || now >= at;
}

/**
 * Evidence held for an enrollment that a sign-off must have seen: retained refusals (rows are
 * kept and only ever added, one per distinct record) and restore reports (every one, whatever
 * became of it).
 */
export type EvidenceMark = Readonly<{ refusals: number; restores: number }>;

export async function evidenceMark(
  tx: Tx,
  scope: Readonly<{ tenantId: string; enrollmentId: string }>,
): Promise<EvidenceMark> {
  const where = { tenantId: scope.tenantId, enrollmentId: scope.enrollmentId };
  const refusals = await tx.offlineJournalReview.count({ where });
  const restores = await tx.offlineJournalRecovery.count({
    where: { ...where, kind: "counter_restore" },
  });
  return { refusals, restores };
}

export type SignOffFacts = Readonly<{
  nominationVersion: number;
  head: JournalPosition;
  approvedAt: number;
  /** Null on a sign-off recorded before the evidence it saw was kept: never current. */
  evidence: EvidenceMark | null;
}>;

/** Whether a sign-off still covers the counter's journal as it is now. */
export function signOffCurrent(
  signOff: SignOffFacts,
  now: Readonly<{
    nominationVersion: number;
    head: JournalPosition;
    cutoff: AuthorityCutoff;
    evidence: EvidenceMark;
  }>,
): boolean {
  const lastGrant = now.cutoff.lastGrantExpiresAt;
  return (
    signOff.nominationVersion === now.nominationVersion &&
    signOff.head.sequence === now.head.sequence &&
    signOff.head.hash === now.head.hash &&
    (lastGrant === null || signOff.approvedAt >= lastGrant) &&
    signOff.evidence !== null &&
    signOff.evidence.refusals === now.evidence.refusals &&
    signOff.evidence.restores === now.evidence.restores
  );
}

/** D11's journal half: a sign-off that still covers the journal. */
export function journalHalfCleared(
  signOff: SignOffFacts | null,
  now: Parameters<typeof signOffCurrent>[1],
): boolean {
  return signOff !== null && signOffCurrent(signOff, now);
}

/** The live missing-journal sign-off for an enrollment, if any, as facts. */
export async function liveSignOff(
  tx: Tx,
  scope: Readonly<{ tenantId: string; enrollmentId: string }>,
): Promise<
  (SignOffFacts & { recoveryId: string; approvedByUserId: string }) | null
> {
  const row = await tx.offlineJournalRecovery.findFirst({
    where: {
      tenantId: scope.tenantId,
      enrollmentId: scope.enrollmentId,
      kind: "missing_journal",
      status: "approved",
    },
    select: {
      id: true,
      nominationVersion: true,
      serverHeadSequence: true,
      serverHeadHash: true,
      approvedAt: true,
      approvedByUserId: true,
      refusalsSeen: true,
      restoresSeen: true,
    },
  });
  if (
    !row ||
    row.nominationVersion === null ||
    !row.approvedAt ||
    !row.approvedByUserId
  )
    return null;
  return {
    recoveryId: row.id,
    approvedByUserId: row.approvedByUserId,
    nominationVersion: row.nominationVersion,
    head: {
      sequence: Number(row.serverHeadSequence),
      hash: row.serverHeadHash,
    },
    approvedAt: row.approvedAt.getTime(),
    evidence:
      row.refusalsSeen === null || row.restoresSeen === null
        ? null
        : { refusals: row.refusalsSeen, restores: row.restoresSeen },
  };
}

/**
 * Read on the activation's transaction after it locked the branch's nomination row, so the
 * accepted head, the latest grant and the sign-off are read against the nomination it moves.
 * The old counter's journal lock is taken too (nomination first, as the sign-off does): an
 * unrevoked counter whose grant expired can still upload, and its head must not move between
 * this read and the activation committing. Returns the sign-off used, or null when there is
 * none that covers the journal.
 */
export async function missingJournalEvidence(
  tx: Tx,
  previous: Readonly<{
    tenantId: string;
    branchId: string;
    terminalId: string;
    enrollmentId: string;
    keyId: string;
    version: number;
  }>,
  cutoff: AuthorityCutoff,
): Promise<{ recoveryId: string } | null> {
  await lockEnrollmentJournal(tx, previous.tenantId, previous.enrollmentId);
  const head = await acceptedJournalHead(tx, {
    tenantId: previous.tenantId,
    branchId: previous.branchId,
    terminalId: previous.terminalId,
    enrollmentId: previous.enrollmentId,
    keyId: previous.keyId,
  });
  const signOff = await liveSignOff(tx, previous);
  if (
    !signOff ||
    !journalHalfCleared(signOff, {
      nominationVersion: previous.version,
      head,
      cutoff,
      evidence: await evidenceMark(tx, previous),
    })
  )
    return null;
  return { recoveryId: signOff.recoveryId };
}
