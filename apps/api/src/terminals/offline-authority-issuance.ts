import type { KeyObject } from "node:crypto";
import type { BranchStockSnapshot, OfflineGrant, Signed, TerminalIdentity } from "@pharmaceylon/shared";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { AccessService } from "../security/access.service";
import { signOfflineGrant } from "./offline-grant";
import { recordSignedStockSnapshot, type SnapshotState } from "./stock-snapshot";
import { denied } from "./terminal-wire";

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
    const nomination = await tx.offlineTerminalNomination.findFirst({
      where: { ...identity, enrollment: { revokedAt: null, terminal: { retiredAt: null } } },
      select: { id: true },
    });
    if (!nomination) denied("IDENTITY_MISMATCH");

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
