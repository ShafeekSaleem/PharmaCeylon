import { randomUUID, sign, verify, type KeyObject } from "node:crypto";
import {
  assertStockSnapshotBounds,
  terminalSigningText,
  type BranchStockSnapshot,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import { Prisma } from "@prisma/client";
import { safeTimeZone } from "../common/business-date.util";
import type { PrismaService } from "../prisma/prisma.service";
import { readStockSnapshotLines } from "./stock-snapshot-lines";
import { denied } from "./terminal-wire";

export type SnapshotState = {
  includedThroughSequence: number;
  includedThroughHash: string | null;
  reviewRequiredBatchIds: ReadonlySet<string>;
};

/** Internal builder for issuance after the caller has authenticated the enrolled device.
 * The reconciliation store supplies the watermark and unresolved batches.
 */
export function buildSignedStockSnapshot(
  prisma: PrismaService,
  identity: TerminalIdentity,
  signer: { keyId: string; privateKey: KeyObject },
  defaultVatRatePercent: number,
  readState: (tx: Prisma.TransactionClient, identity: TerminalIdentity) => Promise<SnapshotState>,
): Promise<Signed<BranchStockSnapshot>> {
  return prisma.$transaction(
    (tx) => recordSignedStockSnapshot(tx, identity, signer, defaultVatRatePercent, readState),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function recordSignedStockSnapshot(
  tx: Prisma.TransactionClient,
  identity: TerminalIdentity,
  signer: { keyId: string; privateKey: KeyObject },
  defaultVatRatePercent: number,
  readState: (tx: Prisma.TransactionClient, identity: TerminalIdentity) => Promise<SnapshotState>,
): Promise<Signed<BranchStockSnapshot>> {
  if (!signer.keyId.trim() || signer.privateKey.type !== "private" || signer.privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Invalid snapshot signing key");
  }

  const nomination = await tx.offlineTerminalNomination.findFirst({
    where: {
      ...identity,
      enrollment: { revokedAt: null, terminal: { retiredAt: null } },
    },
    select: { id: true },
  });
  if (!nomination) denied("IDENTITY_MISMATCH");

  const { tenantId, branchId } = identity;
  const historyScope = { tenantId, branchId, enrollmentId: identity.enrollmentId };
  const latest = await tx.offlineStockSnapshot.findFirst({
    where: historyScope,
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { timezone: true },
  });
  const settings = await tx.tenantSettings.findUnique({
    where: { tenantId },
    select: { vatRatePercent: true },
  });
  const rate = settings?.vatRatePercent ?? new Prisma.Decimal(defaultVatRatePercent);
  const generatedAt = new Date();
  const state = await readState(tx, identity);
  const payload: BranchStockSnapshot = {
    contractVersion: 1,
    kind: "branch_stock_snapshot",
    snapshotId: randomUUID(),
    snapshotVersion: (latest?.version ?? 0) + 1,
    identity,
    generatedAt: generatedAt.getTime(),
    includedThroughSequence: state.includedThroughSequence,
    includedThroughHash: state.includedThroughHash,
    lines: await readStockSnapshotLines(tx, { tenantId, branchId }, {
      generatedAt,
      timeZone: safeTimeZone(tenant.timezone),
      taxBasisPoints: rate.mul(100).toNumber(),
      reviewRequiredBatchIds: state.reviewRequiredBatchIds,
    }),
  };
  assertStockSnapshotBounds(payload);
  const envelope = {
    algorithm: "Ed25519",
    keyId: signer.keyId,
    payload,
    signature: sign(null, Buffer.from(terminalSigningText("snapshot", payload)), signer.privateKey)
      .toString("base64url"),
  } as const;
  // The enrollment/version constraint prevents concurrent builders from committing two
  // snapshots with the same version. A losing transaction must retry from a fresh view.
  await tx.offlineStockSnapshot.create({
    data: {
      ...historyScope,
      id: payload.snapshotId,
      version: payload.snapshotVersion,
      generatedAt,
      envelope,
    },
  });
  return envelope;
}

/** Verify against a pinned server key and the independently known device identity. */
export function verifyStockSnapshot(
  snapshot: Signed<BranchStockSnapshot>,
  identity: TerminalIdentity,
  trustedSigner: { keyId: string; publicKey: KeyObject },
): boolean {
  try {
    if (snapshot.algorithm !== "Ed25519" || snapshot.keyId !== trustedSigner.keyId ||
        trustedSigner.publicKey.asymmetricKeyType !== "ed25519" ||
        !/^[A-Za-z0-9_-]{86}$/.test(snapshot.signature)) return false;
    const signature = Buffer.from(snapshot.signature, "base64url");
    if (signature.toString("base64url") !== snapshot.signature) return false;
    assertStockSnapshotBounds(snapshot.payload);
    const bound = snapshot.payload.identity;
    if (bound.tenantId !== identity.tenantId || bound.branchId !== identity.branchId ||
        bound.terminalId !== identity.terminalId || bound.enrollmentId !== identity.enrollmentId ||
        bound.keyId !== identity.keyId) return false;
    return verify(null, Buffer.from(terminalSigningText("snapshot", snapshot.payload)),
      trustedSigner.publicKey, signature);
  } catch {
    return false;
  }
}
