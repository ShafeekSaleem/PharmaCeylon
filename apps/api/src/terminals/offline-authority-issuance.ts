import type { KeyObject } from "node:crypto";
import type { BranchStockSnapshot, OfflineGrant, Signed, TerminalIdentity } from "@pharmaceylon/shared";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { AccessService } from "../security/access.service";
import { signOfflineGrant } from "./offline-grant";
import { recordSignedStockSnapshot, type SnapshotState } from "./stock-snapshot";
import { denied } from "./terminal-wire";

/**
 * The journal baseline for a new issuance. Until P5 reconciliation supplies the accepted journal
 * watermark and stock-review blocks, only an enrollment's first issuance has a proven empty
 * baseline; any later new request is refused rather than rebased on a guess.
 */
export async function firstIssuanceState(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
): Promise<SnapshotState> {
  const previous = await tx.offlineAuthorityIssuance.findFirst({
    where: { tenantId: identity.tenantId, branchId: identity.branchId, enrollmentId: identity.enrollmentId },
    select: { commandId: true },
  });
  if (previous) denied("RECONCILIATION_REQUIRED");
  return { includedThroughSequence: 0, includedThroughHash: null, reviewRequiredBatchIds: new Set() };
}

/** Whether this exact enrollment is the branch's current, unrevoked offline counter. */
export async function isNominated(tx: Prisma.TransactionClient, identity: TerminalIdentity): Promise<boolean> {
  const nomination = await tx.offlineTerminalNomination.findFirst({
    where: { ...identity, enrollment: { revokedAt: null, terminal: { retiredAt: null } } },
    select: { id: true },
  });
  return nomination !== null;
}

/** The authenticator verifies device, actor and command ID on every attempt, including replay.
 * readState establishes a safe journal baseline before any new grant is minted.
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
    if (!(await isNominated(tx, identity))) denied("IDENTITY_MISMATCH");

    const previous = await tx.offlineAuthorityIssuance.findUnique({
      where: { tenantId_branchId_enrollmentId_commandId: { ...scope, commandId } },
    });
    if (previous) {
      const snapshot = await tx.offlineStockSnapshot.findFirstOrThrow({
        where: { ...scope, id: previous.snapshotId },
        select: { envelope: true },
      });
      return {
        grant: previous.grant as unknown as Signed<OfflineGrant>,
        snapshot: snapshot.envelope as unknown as Signed<BranchStockSnapshot>,
      };
    }

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

  try {
    return await issue();
  } catch (error) {
    // Retry an overlapping issuance from a fresh view so a committed command can be replayed.
    if (error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2002" || error.code === "P2034")) return issue();
    throw error;
  }
}
