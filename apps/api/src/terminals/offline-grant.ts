import { randomUUID, sign, type KeyObject } from "node:crypto";
import {
  assertOfflineGrantBounds,
  MAX_OFFLINE_GRANT_MS,
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  terminalSigningText,
  type OfflineGrant,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import type { Prisma } from "@prisma/client";
import type { AccessService } from "../security/access.service";
import { storedPolicy } from "../tenant/counter-policy.service";
import { readOfflineGrantStaff } from "./offline-grant-staff";
import { compileOfflineHours } from "./operating-hours";
import { denied } from "./terminal-wire";

/** Called inside authenticated issuance, which owns grant versioning and durable replay. */
export async function signOfflineGrant(
  tx: Prisma.TransactionClient,
  access: AccessService,
  identity: TerminalIdentity,
  grantVersion: number,
  signer: { keyId: string; privateKey: KeyObject },
  now = new Date(),
): Promise<Signed<OfflineGrant>> {
  if (!signer.keyId.trim() || signer.privateKey.type !== "private" ||
      signer.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid grant signing key");
  const { tenantId, branchId } = identity;
  const nomination = await tx.offlineTerminalNomination.findFirst({
    where: { ...identity, enrollment: { revokedAt: null, terminal: { retiredAt: null } } },
    select: { version: true, enrollment: { select: { terminal: { select: { registerId: true, tillId: true } } } } },
  });
  if (!nomination) denied("IDENTITY_MISMATCH");
  const { registerId, tillId } = nomination.enrollment.terminal;
  if (!registerId || !tillId) denied("GRANT_INVALID");
  const branch = await tx.branch.findFirst({
    where: { tenantId, id: branchId, isActive: true, tenant: { isActive: true } },
    select: { counterPolicy: true, counterPolicyVersion: true, timezone: true, operatingHours: true },
  });
  if (!branch) denied("GRANT_INVALID");
  const policy = storedPolicy(branch.counterPolicy);
  if (!policy.offlineEnabled) denied("GRANT_INVALID");
  const authorizedStaff = await readOfflineGrantStaff(tx, access, identity, now);
  if (!authorizedStaff.length) denied("GRANT_INVALID");
  const issuedAt = now.getTime();
  const expiresAt = issuedAt + MAX_OFFLINE_GRANT_MS;
  const extensions = await tx.branchHoursExtension.findMany({
    where: { tenantId, branchId, revokedAt: null, startsAt: { lt: new Date(expiresAt) }, endsAt: { gt: now } },
    select: { startsAt: true, endsAt: true },
  });
  const windows = compileOfflineHours(
    { hours: branch.operatingHours, timeZone: branch.timezone, extensions }, issuedAt, expiresAt,
  );
  const payload: OfflineGrant = {
    contractVersion: 1, kind: "offline_grant", identity, registerId, tillId, authorizedStaff,
    grantId: randomUUID(), grantVersion, nominationVersion: nomination.version, issuedAt,
    notBefore: issuedAt, expiresAt, maxSnapshotAgeAtOutageMs: MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
    currency: "LKR", externalCardAllowed: policy.offlineExternalCardEnabled,
    policyVersion: branch.counterPolicyVersion, ...windows, operatingHoursException: null,
  };
  assertOfflineGrantBounds(payload);
  return {
    algorithm: "Ed25519", keyId: signer.keyId, payload,
    signature: sign(null, Buffer.from(terminalSigningText("grant", payload)), signer.privateKey).toString("base64url"),
  };
}
