import { verify, type KeyObject } from "node:crypto";
import {
  assertOfflineGrantBounds,
  assertSafeInteger,
  assertStockSnapshotBounds,
  terminalSigningText,
  type BranchStockSnapshot,
  type OfflineGrant,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";

import type { PosDatabase } from "../db/database";

export type OfflineAuthority = {
  grant: Signed<OfflineGrant>;
  snapshot: Signed<BranchStockSnapshot>;
};

const identityFields = ["tenantId", "branchId", "terminalId", "enrollmentId", "keyId"] as const;

/** Verify in the main process before handing a response to the durable journal installer. */
export function verifyOfflineAuthority(
  response: OfflineAuthority,
  expected: {
    identity: TerminalIdentity;
    registerId: string;
    tillId: string;
    signer: { keyId: string; publicKey: KeyObject };
    trustedNow: number;
  },
): boolean {
  function authentic(purpose: "grant" | "snapshot", envelope: Signed<OfflineGrant | BranchStockSnapshot>) {
    if (envelope.algorithm !== "Ed25519" || envelope.keyId !== expected.signer.keyId ||
        typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature) ||
        !identityFields.every(field => envelope.payload.identity[field] === expected.identity[field])) return false;
    const signature = Buffer.from(envelope.signature, "base64url");
    return signature.toString("base64url") === envelope.signature &&
      verify(null, Buffer.from(terminalSigningText(purpose, envelope.payload)), expected.signer.publicKey, signature);
  }

  try {
    if (expected.signer.publicKey.type !== "public" ||
        expected.signer.publicKey.asymmetricKeyType !== "ed25519") return false;
    assertSafeInteger(expected.trustedNow);
    if (!authentic("grant", response.grant) || !authentic("snapshot", response.snapshot)) return false;
    const grant = response.grant.payload;
    const snapshot = response.snapshot.payload;
    assertOfflineGrantBounds(grant);
    assertStockSnapshotBounds(snapshot);
    return grant.contractVersion === 1 && grant.kind === "offline_grant" &&
      grant.currency === "LKR" && typeof grant.externalCardAllowed === "boolean" &&
      grant.registerId === expected.registerId && grant.tillId === expected.tillId &&
      grant.grantVersion === snapshot.snapshotVersion &&
      snapshot.generatedAt <= grant.issuedAt &&
      grant.notBefore <= expected.trustedNow && expected.trustedNow < grant.expiresAt &&
      expected.trustedNow - snapshot.generatedAt <= grant.maxSnapshotAgeAtOutageMs;
  } catch {
    return false;
  }
}

/** Store a verified pair together. Further versions require the journal installer to
 * preserve local consumption and unresolved commands while rebasing the snapshot. */
export function installInitialOfflineAuthority(
  db: PosDatabase,
  response: OfflineAuthority,
  expected: Parameters<typeof verifyOfflineAuthority>[1],
): "installed" | "already_installed" | "invalid" | "reconciliation_required" {
  if (!verifyOfflineAuthority(response, expected)) return "invalid";
  const enrollmentId = expected.identity.enrollmentId;
  const version = response.grant.payload.grantVersion;
  const installed = db.transaction(() => {
    const previous = db.prepare(`
      SELECT version, grant_envelope, snapshot_envelope
      FROM offline_authority WHERE enrollment_id = ?
    `).get(enrollmentId) as { version: number; grant_envelope: string; snapshot_envelope: string } | undefined;
    if (previous) {
      if (previous.version < version) return "reconciliation_required";
      if (previous.version !== version) return "invalid";
      const grant = JSON.parse(previous.grant_envelope) as Signed<OfflineGrant>;
      const snapshot = JSON.parse(previous.snapshot_envelope) as Signed<BranchStockSnapshot>;
      return grant.signature === response.grant.signature && snapshot.signature === response.snapshot.signature
        ? "already_installed" : "invalid";
    }
    if (version !== 1 || response.snapshot.payload.includedThroughSequence !== 0)
      return "reconciliation_required";
    db.prepare(`
      INSERT INTO offline_authority (enrollment_id, version, grant_envelope, snapshot_envelope)
      VALUES (?, ?, ?, ?)
    `).run(enrollmentId, version, JSON.stringify(response.grant), JSON.stringify(response.snapshot));
    return "installed";
  });
  return installed.immediate();
}
