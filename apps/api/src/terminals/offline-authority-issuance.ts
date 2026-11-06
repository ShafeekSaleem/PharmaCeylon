import type { KeyObject } from "node:crypto";
import type { BranchStockSnapshot, OfflineGrant, Signed, TerminalIdentity } from "@pharmaceylon/shared";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { AccessService } from "../security/access.service";
import { blockedBatchIds } from "../inventory/stock/sale-blocks";
import { signOfflineGrant } from "./offline-grant";
import { recordSignedStockSnapshot, type SnapshotState } from "./stock-snapshot";
import { denied } from "./terminal-wire";

/** Whether this enrollment has any accepted offline journal entry (a sequenced command receipt). */
export async function hasAcceptedOfflineJournal(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
): Promise<boolean> {
  const entry = await tx.terminalCommandReceipt.findFirst({
    where: { tenantId: identity.tenantId, enrollmentId: identity.enrollmentId, offlineSequence: { not: null } },
    select: { id: true },
  });
  return entry !== null;
}

/**
 * The journal baseline for a new issuance or renewal, read from the accepted offline journal in
 * the issuance's own consistent view. The journal is enrollment-wide: each offline command an
 * enrollment uploads is accepted as a `terminal_command_receipt` with its `offline_sequence`.
 *
 * While none has been accepted, the baseline is provably empty: watermark 0 and no hash. The
 * stock-review blocks are the branch's open batch sale blocks (P5 #51), which another counter's
 * accepted journal may have opened. Once this enrollment has an accepted journal entry, rebasing
 * the snapshot over it is a later P5 slice, so the request is refused rather than rebased on a
 * guess.
 *
 * A journal entry accepted concurrently with an issuance serializes after it: the pair issued
 * at watermark 0 was correct when it was read, and the counter that uploaded the entry holds a
 * non-empty local journal, so its installer refuses to rebase onto that pair.
 */
export async function emptyJournalState(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
): Promise<SnapshotState> {
  if (await hasAcceptedOfflineJournal(tx, identity)) denied("RECONCILIATION_REQUIRED");
  // P5 #51 (approved D1): batches an open offline discrepancy case holds, whichever counter's
  // journal opened it (e.g. the counter this one replaced), are never sellable offline either.
  return {
    includedThroughSequence: 0,
    includedThroughHash: null,
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
