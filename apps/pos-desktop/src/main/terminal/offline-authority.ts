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
import { hasLocalOfflineUsage } from "./offline-journal";
import { resetJournalUsageForEnrollment } from "./offline-journal-writer";

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

export type InstallResult =
  /** Stored: the first pair, or a newer version replacing the installed one. */
  | "installed"
  /** This exact pair is already installed (a replayed response). */
  | "already_installed"
  /** Authentic, but older than the installed pair: a late reply to an earlier request. */
  | "superseded"
  /** Failed verification, or a different pair claiming the installed version. Never stored. */
  | "invalid"
  /** Offline use is recorded here against the installed pair; P5 must reconcile it first. */
  | "local_usage"
  /** The server rebased over an accepted journal (watermark above 0): P5's installer. */
  | "reconciliation_required";

type InstalledRow = { version: number; grant_envelope: string; snapshot_envelope: string };

/** The installed pair for this enrollment, if any. */
export function readInstalledOfflineAuthority(
  db: PosDatabase,
  enrollmentId: string,
): (OfflineAuthority & { version: number }) | null {
  const row = db.prepare(`
    SELECT version, grant_envelope, snapshot_envelope FROM offline_authority WHERE enrollment_id = ?
  `).get(enrollmentId) as InstalledRow | undefined;
  if (!row) return null;
  return {
    version: row.version,
    grant: JSON.parse(row.grant_envelope) as Signed<OfflineGrant>,
    snapshot: JSON.parse(row.snapshot_envelope) as Signed<BranchStockSnapshot>,
  };
}

/**
 * The rebasing installer. Verifies the pair, then, in one immediate transaction, stores it as
 * this counter's only installed pair. A newer version replaces the installed one only while
 * nothing has used offline authority here (`hasLocalOfflineUsage`): once P4 has journalled a
 * sale or shift against the installed pair, that pair is the journal's baseline and stays until
 * P5 reconciles. A pair the server rebased over an accepted journal is P5's to install too.
 *
 * Earlier pairs are not kept on the counter: one that was replaced was never used here (that is
 * the condition for replacing it), and the server keeps every issued version as immutable
 * evidence. A pair that fails verification is never stored.
 */
export function installOfflineAuthority(
  db: PosDatabase,
  response: OfflineAuthority,
  expected: Parameters<typeof verifyOfflineAuthority>[1],
  usage: (db: PosDatabase, enrollmentId: string) => boolean = hasLocalOfflineUsage,
): InstallResult {
  if (!verifyOfflineAuthority(response, expected)) return "invalid";
  const enrollmentId = expected.identity.enrollmentId;
  const version = response.grant.payload.grantVersion;
  const install = db.transaction((): InstallResult => {
    const previous = readInstalledOfflineAuthority(db, enrollmentId);
    if (previous && previous.version === version)
      return previous.grant.signature === response.grant.signature &&
        previous.snapshot.signature === response.snapshot.signature ? "already_installed" : "invalid";
    if (previous && previous.version > version) return "superseded";
    // A newer version must be newer evidence, never an older view under a higher number.
    if (previous && (response.snapshot.payload.generatedAt < previous.snapshot.payload.generatedAt ||
        response.grant.payload.issuedAt < previous.grant.payload.issuedAt)) return "invalid";
    if (response.snapshot.payload.includedThroughSequence !== 0 || response.snapshot.payload.includedThroughHash !== null)
      return "reconciliation_required";
    if (usage(db, enrollmentId)) return "local_usage";
    const values = [version, JSON.stringify(response.grant), JSON.stringify(response.snapshot), enrollmentId];
    if (previous) {
      const replaced = db.prepare(`
        UPDATE offline_authority SET version = ?, grant_envelope = ?, snapshot_envelope = ?
        WHERE enrollment_id = ? AND version = ?
      `).run(...values, previous.version);
      if (replaced.changes !== 1) throw new Error("Installed offline authority changed during install");
    } else {
      db.prepare(`
        INSERT INTO offline_authority (version, grant_envelope, snapshot_envelope, enrollment_id)
        VALUES (?, ?, ?, ?)
      `).run(...values);
    }
    resetJournalUsageForEnrollment(db, enrollmentId);
    return "installed";
  });
  return install.immediate();
}
