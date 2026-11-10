import { verify, type KeyObject } from "node:crypto";
import {
  assertOfflineGrantBounds,
  assertSafeInteger,
  assertStockSnapshotBounds,
  mayResumeOnlineCheckout,
  terminalSigningText,
  type BranchStockSnapshot,
  type OfflineGrant,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";

import type { PosDatabase } from "../db/database";
import { activeOutage, journalCoverage } from "./offline-journal";
import { resetJournalUsageForEnrollment } from "./offline-journal-writer";
import { drainResumeEvidence, endOutage, recordAcceptedWatermark } from "./reconnect-drain";
import { clearAcknowledgedRestores, restoredGrantFloor, restoresAwaitingAcknowledgement } from "./store-restore-sync";

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
  /** Journal entries recorded here that the pair's watermark doesn't include: upload them first. */
  | "local_usage"
  /** The pair's watermark names journal entries this computer doesn't have: never installed. */
  | "journal_mismatch"
  /** It would finish an outage's drain, but a sale or action sent from here is still unconfirmed. */
  | "drain_incomplete"
  /**
   * P5 #51: this store was restored from a backup and the back office has not acknowledged that
   * yet. Never installed meanwhile (the server refuses to issue one too).
   */
  | "restore_unacknowledged";

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
 * The rebasing installer (P3 #49, rebasing over a journal P5 #51). Verifies the pair, then, in one
 * immediate transaction, stores it as this counter's only installed pair.
 *
 * The snapshot's watermark (`includedThroughSequence` / `includedThroughHash`) says which of this
 * enrollment's journal entries the server had accepted when it read the stock: every posted
 * offline sale through it is already out of the snapshot's balances, and every sale still pending
 * reconciliation holds its batches as `stockReviewRequired`. So a newer pair is installed only when
 * that watermark is exactly this computer's journal head (`journalCoverage`):
 *
 * - entries recorded here past the watermark are not in its stock yet: `local_usage` (upload them);
 * - a watermark naming entries this computer doesn't have: `journal_mismatch`, never installed.
 *
 * Installing resets the consumption counted against the replaced snapshot (`resetJournalUsageFor
 * Enrollment`): the new snapshot already includes it. The watermark itself is server-signed
 * evidence of acceptance and is recorded as such. While an outage is waiting for its drain, this
 * install is the drain's last step (approved D12): it happens only once `mayResumeOnlineCheckout`
 * holds with this pair as the fresh snapshot — otherwise `drain_incomplete` — and it ends the
 * outage in the same transaction, so checkout resumes on fresh stock and review blocks or not at
 * all. `usage` is an extra veto for callers that know of local use this store doesn't record.
 *
 * Earlier pairs are not kept on the counter: one that was replaced has nothing recorded against it
 * that the new one doesn't include, and the server keeps every issued version as immutable
 * evidence. A pair that fails verification is never stored.
 */
export function installOfflineAuthority(
  db: PosDatabase,
  response: OfflineAuthority,
  expected: Parameters<typeof verifyOfflineAuthority>[1],
  usage?: (db: PosDatabase, enrollmentId: string) => boolean,
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
    // P5 #51, store restore: nothing at or below the highest version the server had issued when it
    // answered the restore. Such a pair was superseded while the backup was all this computer had.
    if (restoresAwaitingAcknowledgement(db, enrollmentId).length > 0) return "restore_unacknowledged";
    if (version <= restoredGrantFloor(db, enrollmentId)) return "superseded";
    // A newer version must be newer evidence, never an older view under a higher number.
    if (previous && (response.snapshot.payload.generatedAt < previous.snapshot.payload.generatedAt ||
        response.grant.payload.issuedAt < previous.grant.payload.issuedAt)) return "invalid";
    const watermark = {
      sequence: response.snapshot.payload.includedThroughSequence,
      hash: response.snapshot.payload.includedThroughHash,
    };
    const coverage = journalCoverage(db, enrollmentId, watermark);
    if (coverage === "mismatch") return "journal_mismatch";
    if (coverage === "behind") return "local_usage";
    if (usage?.(db, enrollmentId)) return "local_usage";
    const at = new Date(expected.trustedNow).toISOString();
    recordAcceptedWatermark(db, enrollmentId, watermark, at);
    const outage = activeOutage(db, enrollmentId);
    if (outage && !mayResumeOnlineCheckout(drainResumeEvidence(db, enrollmentId, { snapshotCoversJournal: true })))
      return "drain_incomplete";
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
    if (outage) endOutage(db, enrollmentId, at);
    // A pair issued after the restore was acknowledged: the restore no longer stops offline selling.
    clearAcknowledgedRestores(db, enrollmentId, at);
    return "installed";
  });
  return install.immediate();
}
