import type { KeyObject } from "node:crypto";
import type { BranchStockSnapshot, OfflineGrant, Signed, TerminalIdentity } from "@pharmaceylon/shared";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { AccessService } from "../security/access.service";
import { blockedBatchIds } from "../inventory/stock/sale-blocks";
import { signOfflineGrant } from "./offline-grant";
import { recordSignedStockSnapshot, type SnapshotState } from "./stock-snapshot";
import { denied } from "./terminal-wire";

/** The highest accepted offline journal entry (a sequenced command receipt), or sequence 0. */
export async function acceptedJournalHead(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
): Promise<{ sequence: number; hash: string | null }> {
  const head = await tx.terminalCommandReceipt.findFirst({
    where: { tenantId: identity.tenantId, enrollmentId: identity.enrollmentId, offlineSequence: { not: null } },
    orderBy: { offlineSequence: "desc" },
    select: { offlineSequence: true, requestDigest: true },
  });
  return head ? { sequence: Number(head.offlineSequence), hash: head.requestDigest } : { sequence: 0, hash: null };
}

/**
 * Whether this enrollment's journal is stuck past its accepted head on an entry that will never
 * be accepted as sent: one rejected by policy, or one that conflicts with the accepted chain (a
 * fork). Nothing after it can be accepted either (entries are accepted only at head + 1), so the
 * counter cannot finish synchronising until someone reviews it. Held entries (a gap, a sign-in
 * not uploaded yet) are not counted: the counter repairs them by sending what is missing.
 */
export async function journalAwaitingReview(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
  headSequence: number,
): Promise<boolean> {
  const stuck = await tx.offlineJournalReview.findFirst({
    where: {
      tenantId: identity.tenantId,
      enrollmentId: identity.enrollmentId,
      recordKind: "command",
      outcome: { in: ["rejected", "conflict"] },
      sequence: { gt: BigInt(headSequence) },
    },
    select: { id: true },
  });
  return stuck !== null;
}

/**
 * Whether this enrollment's journal recovery (D11, a restored counter) is open: reported or
 * approved but not yet completed by the counter. The counter has not yet set its unmatched
 * entries aside and removed its restored grant, so no new authority is issued to it meanwhile.
 */
export async function journalRecoveryOpen(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
): Promise<boolean> {
  const open = await tx.offlineJournalRecovery.findFirst({
    where: {
      tenantId: identity.tenantId,
      enrollmentId: identity.enrollmentId,
      kind: "counter_restore",
      status: { in: ["awaiting_approval", "approved"] },
    },
    select: { id: true },
  });
  return open !== null;
}

/**
 * The journal baseline for a new issuance or renewal, read in the issuance's own repeatable-read
 * view, together with the stock it signs (P5 #51, the rebase). Each offline command an
 * enrollment uploads is accepted as a `terminal_command_receipt` with its `offline_sequence`, in
 * the same transaction as its whole stock effect or its discrepancy case and batch sale blocks.
 * So the stock this view reads already includes every posted sale through the accepted head, and
 * every sale still pending reconciliation holds its batches in `batch_sale_block`, which the
 * snapshot marks `stockReviewRequired` (approved D1): advancing the watermark never makes those
 * units sellable again.
 *
 * The watermark is the accepted head (0 and no hash while nothing has been accepted). The
 * counter installs the pair only if that head is its own last journal entry, so a pair issued
 * while the counter still has entries to upload is simply not installed. A journal stuck on an
 * entry that needs review is refused (`RECONCILIATION_REQUIRED`): the counter cannot rebase onto
 * it, and minting versions it will never install would only hide the problem. So is a counter
 * whose journal recovery is open (`journalRecoveryOpen`): it gets a pair only once it has
 * completed the recovery.
 *
 * The review blocks are the branch's open batch sale blocks, whichever counter's journal opened
 * them (e.g. the counter this one replaced): those batches are never sellable offline either.
 */
export async function acceptedJournalState(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
): Promise<SnapshotState> {
  const head = await acceptedJournalHead(tx, identity);
  if (await journalAwaitingReview(tx, identity, head.sequence)) denied("RECONCILIATION_REQUIRED");
  if (await journalRecoveryOpen(tx, identity)) denied("RECONCILIATION_REQUIRED");
  return {
    includedThroughSequence: head.sequence,
    includedThroughHash: head.hash,
    reviewRequiredBatchIds: await blockedBatchIds(tx, identity.tenantId, identity.branchId),
  };
}

/** Whether this exact enrollment is the branch's current, unrevoked offline counter. */
export async function isNominated(tx: Prisma.TransactionClient, identity: TerminalIdentity): Promise<boolean> {
  // Shares the row D11 clearance locks: an activation moving the nomination either waits for this
  // issuance (and then sees its grant) or makes it retry and find the counter no longer nominated.
  await tx.$queryRaw`
    SELECT id FROM offline_terminal_nomination
    WHERE tenant_id = ${identity.tenantId}::uuid AND branch_id = ${identity.branchId}::uuid
    FOR SHARE`;
  const nomination = await tx.offlineTerminalNomination.findFirst({
    where: { ...identity, enrollment: { revokedAt: null, terminal: { retiredAt: null } } },
    select: { id: true },
  });
  return nomination !== null;
}

/**
 * isNominated, holding the nomination, enrollment and terminal rows against change until the
 * issuance commits. Moving the nomination to a replacement counter, revoking the enrollment or
 * retiring the terminal therefore either waits for this issuance (which then predates it) or
 * has already committed, in which case this repeatable-read transaction fails to serialize and
 * the retry reads the new nomination. Authority is never issued to a counter after it was
 * replaced.
 */
async function lockNomination(tx: Prisma.TransactionClient, identity: TerminalIdentity): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT n.id FROM offline_terminal_nomination n
    JOIN terminal_enrollment e
      ON e.tenant_id = n.tenant_id AND e.branch_id = n.branch_id AND e.id = n.enrollment_id
    JOIN operational_terminal t
      ON t.tenant_id = e.tenant_id AND t.branch_id = e.branch_id AND t.id = e.terminal_id
    WHERE n.tenant_id = ${identity.tenantId}::uuid AND n.branch_id = ${identity.branchId}::uuid
      AND n.terminal_id = ${identity.terminalId}::uuid AND n.enrollment_id = ${identity.enrollmentId}::uuid
      AND n.key_id = ${identity.keyId} AND e.key_id = ${identity.keyId}
      AND e.revoked_at IS NULL AND t.retired_at IS NULL
    FOR SHARE OF n, e, t`;
  return rows.length === 1;
}

/** Repeatable-read conflicts a fresh view resolves: version races, and serialization failures. */
function retryable(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2002" || error.code === "P2034") return true;
  // A raw locking read surfaces PostgreSQL's serialization failure as a raw query error.
  return error.code === "P2010" && /40001|could not serialize/i.test(JSON.stringify(error.meta ?? {}) + error.message);
}

const ATTEMPTS = 4;

/** The authenticator verifies device, actor and command ID on every attempt, including replay.
 * readState establishes a safe journal baseline before any new grant is minted. Every issuance,
 * first or renewal, is a new immutable version: the snapshot and grant share the version number
 * and earlier versions are kept.
 */
export async function issueOfflineAuthority(
  prisma: PrismaService,
  access: AccessService,
  options: {
    signer: { keyId: string; privateKey: KeyObject };
    defaultVatRatePercent: number;
    authenticate: (tx: Prisma.TransactionClient) => Promise<{ identity: TerminalIdentity; commandId: string }>;
    readState: (tx: Prisma.TransactionClient, identity: TerminalIdentity) => Promise<SnapshotState>;
  },
): Promise<{ grant: Signed<OfflineGrant>; snapshot: Signed<BranchStockSnapshot> }> {
  const issue = () => prisma.$transaction(async (tx) => {
    const { identity, commandId } = await options.authenticate(tx);
    const { tenantId, branchId, enrollmentId } = identity;
    const scope = { tenantId, branchId, enrollmentId };

    const previous = await tx.offlineAuthorityIssuance.findUnique({
      where: { tenantId_branchId_enrollmentId_commandId: { ...scope, commandId } },
    });
    if (previous) {
      // A replay hands back what was already issued, but never to a counter that has since been
      // replaced, revoked or retired.
      if (!(await isNominated(tx, identity))) denied("IDENTITY_MISMATCH");
      const snapshot = await tx.offlineStockSnapshot.findFirstOrThrow({
        where: { ...scope, id: previous.snapshotId },
        select: { envelope: true },
      });
      return {
        grant: previous.grant as unknown as Signed<OfflineGrant>,
        snapshot: snapshot.envelope as unknown as Signed<BranchStockSnapshot>,
      };
    }
    if (!(await lockNomination(tx, identity))) denied("IDENTITY_MISMATCH");

    const snapshot = await recordSignedStockSnapshot(
      tx, identity, options.signer, options.defaultVatRatePercent, options.readState,
    );
    const grant = await signOfflineGrant(
      tx, access, identity, snapshot.payload.snapshotVersion, options.signer,
    );
    await tx.offlineAuthorityIssuance.create({
      data: { ...scope, commandId, snapshotId: snapshot.payload.snapshotId, grant },
    });
    return { grant, snapshot };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  for (let attempt = 1; ; attempt++) {
    try {
      return await issue();
    } catch (error) {
      // An overlapping issuance or nomination change: retry from a fresh view, which replays a
      // committed identical command, takes the next version, or sees the new nomination.
      if (attempt < ATTEMPTS && retryable(error)) continue;
      if (retryable(error)) denied("TEMPORARILY_UNAVAILABLE");
      throw error;
    }
  }
}
