import { createHash, randomUUID } from "node:crypto";
import type {
  BranchStockSnapshot,
  LocalOpenTillShift,
  OfflineGrant,
  OfflineJournalCommand,
  OfflineSaleCommand,
  OfflineStaffSignIn,
  Signed,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import {
  MAX_SNAPSHOT_AGE_AT_OUTAGE_MS,
  offlineSalePolicyError,
  terminalSigningText,
} from "@pharmaceylon/shared";

import type { PosDatabase } from "../db/database";
import { readInstalledOfflineAuthority } from "./offline-authority";
import { verifyDeviceCommandSignature } from "./device-signature";
import { journalNeedsRecovery } from "./reconnect-drain";
import { storeRestoreBlocksOffline } from "./store-restore-sync";

export function journalCommandHash(payload: unknown): string {
  return createHash("sha256")
    .update(terminalSigningText("command", payload), "utf8")
    .digest("hex");
}

export function readEnrolledDevice(db: PosDatabase): (TerminalIdentity & { publicKeyHex: string }) | null {
  const row = db
    .prepare(
      `SELECT tenant_id, branch_id, terminal_id, enrollment_id, key_id, public_key_hex
       FROM device_identity WHERE id = 1`,
    )
    .get() as
    | {
        tenant_id: string;
        branch_id: string;
        terminal_id: string;
        enrollment_id: string;
        key_id: string;
        public_key_hex: string;
      }
    | undefined;
  if (!row) return null;
  return {
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    terminalId: row.terminal_id,
    enrollmentId: row.enrollment_id,
    keyId: row.key_id,
    publicKeyHex: row.public_key_hex,
  };
}

export function sameTerminalIdentity(a: TerminalIdentity, b: TerminalIdentity): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.branchId === b.branchId &&
    a.terminalId === b.terminalId &&
    a.enrollmentId === b.enrollmentId &&
    a.keyId === b.keyId
  );
}

export function readSnapshotScope(
  db: PosDatabase,
  enrollmentId: string,
): { snapshotId: string; snapshotVersion: number } | null {
  const installed = readInstalledOfflineAuthority(db, enrollmentId);
  if (!installed) return null;
  const s = installed.snapshot.payload;
  return { snapshotId: s.snapshotId, snapshotVersion: s.snapshotVersion };
}

type JournalStateRow = {
  journal_last_sequence: number;
  journal_last_hash: string | null;
  offline_session_id: string | null;
  offline_started_at: number | null;
  active_staff_sign_in_id: string | null;
  active_staff_envelope_json: string | null;
};

type JournalStatePartial = {
  journal_last_sequence: number;
  journal_last_hash: string | null;
  offline_session_id: string | null;
  offline_started_at: number | null;
  active_staff_sign_in_id: string | null;
  active_staff_envelope_json: string | null;
};

function readState(db: PosDatabase, enrollmentId: string): JournalStateRow | null {
  const row = db
    .prepare(
      `SELECT journal_last_sequence, journal_last_hash, offline_session_id, offline_started_at,
              active_staff_sign_in_id, active_staff_envelope_json
       FROM offline_journal_state WHERE enrollment_id = ?`,
    )
    .get(enrollmentId) as JournalStateRow | undefined;
  return row ?? null;
}

/**
 * Clears usage keyed to a replaced snapshot when a fresh authority pair is installed (no local usage).
 * Caller runs inside `installOfflineAuthority` transaction.
 */
export function resetJournalUsageForEnrollment(db: PosDatabase, enrollmentId: string): void {
  db.prepare("DELETE FROM offline_journal_batch_usage WHERE enrollment_id = ?").run(enrollmentId);
  db.prepare("DELETE FROM offline_journal_online_sale_record WHERE enrollment_id = ?").run(enrollmentId);
}

/**
 * P4: records immutable offline staff sign-in evidence, updates the active sign-in for journal
 * commands, and appends signed journal entries with chain integrity (sequence, previous hash).
 */
export class OfflineJournalWriter {
  constructor(
    private readonly deps: {
      db: PosDatabase;
      now?: () => Date;
    },
  ) {}

  private clock(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private nowMs() {
    return this.clock().getTime();
  }

  private atIso() {
    return this.clock().toISOString();
  }

  /**
   * After a successful PIN sign-in at the counter, while online authority is installed.
   *
   * `confirmedPinVersion` is `TerminalStaffCredentialView.pinVersion` from GET
   * `/terminals/sessions/:workSessionId/credential` (fetched after pin-sessions succeeds). The
   * pin-sessions response does not expose a credential revision. Grant `credentialVersion` uses the
   * same meaning as `pinVersion` at grant issue (`readOfflineGrantStaff` on the API). When they
   * differ the installed grant is stale for this sign-in; recording nothing is safer than
   * attesting a PIN generation the grant did not authorize.
   */
  recordStaffSignInFromPin(options: {
    enrollmentId: string;
    identity: TerminalIdentity;
    registerId: string;
    tillId: string;
    session: { workSessionId: string; staffUserId: string };
    key: { sign: <T>(payload: T, purpose: "command") => Signed<T> };
    /** Server-confirmed PIN revision after sign-in; must match grant staff `credentialVersion`. */
    confirmedPinVersion: number;
  }): Signed<OfflineStaffSignIn> | null {
    const installed = readInstalledOfflineAuthority(this.deps.db, options.enrollmentId);
    if (!installed) return null;
    const grant = installed.grant.payload;
    const staff = grant.authorizedStaff.find((s) => s.staffUserId === options.session.staffUserId);
    if (!staff) return null;
    if (options.confirmedPinVersion !== staff.credentialVersion) return null;

    const trustedNow = this.nowMs();
    if (trustedNow >= grant.expiresAt || trustedNow < grant.notBefore) return null;

    const staffSignInId = randomUUID();
    const payload: OfflineStaffSignIn = {
      contractVersion: 1,
      kind: "offline_staff_sign_in",
      staffSignInId,
      identity: options.identity,
      session: {
        registerId: options.registerId,
        tillId: options.tillId,
        workSessionId: options.session.workSessionId,
        staffUserId: options.session.staffUserId,
      },
      grantId: grant.grantId,
      grantVersion: grant.grantVersion,
      staffAuthorizationId: staff.staffAuthorizationId,
      credentialVersion: staff.credentialVersion,
      method: "personal_pin",
      authenticatedAt: trustedNow,
    };
    const envelope = options.key.sign(payload, "command");
    const at = this.atIso();
    const tx = this.deps.db.transaction(() => {
      this.deps.db
        .prepare(
          `INSERT INTO offline_journal_staff_sign_in (staff_sign_in_id, enrollment_id, envelope_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(staffSignInId, options.enrollmentId, JSON.stringify(envelope), at);
      this.upsertStateRow(options.enrollmentId, (prev) => ({
        journal_last_sequence: prev?.journal_last_sequence ?? 0,
        journal_last_hash: prev?.journal_last_hash ?? null,
        offline_session_id: prev?.offline_session_id ?? null,
        offline_started_at: prev?.offline_started_at ?? null,
        active_staff_sign_in_id: staffSignInId,
        active_staff_envelope_json: JSON.stringify(envelope),
      }));
    });
    tx();
    return envelope;
  }

  /**
   * Idempotent: records online sale consumption once per `saleId` for the current installed snapshot.
   * Run in the same transaction as marking the checkout draft complete.
   */
  recordOnlineSaleLinesIfNew(
    saleId: string,
    enrollmentId: string,
    lines: ReadonlyArray<{ batchId: string; qty: number }>,
    atIso: string,
  ): void {
    const scope = readSnapshotScope(this.deps.db, enrollmentId);
    if (!scope || !lines.length) return;
    const inserted = this.deps.db
      .prepare(
        `INSERT OR IGNORE INTO offline_journal_online_sale_record (enrollment_id, sale_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(enrollmentId, saleId, atIso);
    if (inserted.changes === 0) return;

    const bump = this.deps.db.prepare(`
      INSERT INTO offline_journal_batch_usage
        (enrollment_id, snapshot_id, snapshot_version, batch_id, qty_sold)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (enrollment_id, snapshot_id, snapshot_version, batch_id) DO UPDATE SET
        qty_sold = offline_journal_batch_usage.qty_sold + excluded.qty_sold
    `);
    for (const line of lines) {
      if (!line.batchId || !Number.isSafeInteger(line.qty) || line.qty <= 0) continue;
      bump.run(enrollmentId, scope.snapshotId, scope.snapshotVersion, line.batchId, line.qty);
    }
  }

  /** Journal head for P5 upload and for new commands. */
  getHead(enrollmentId: string): { sequence: number; previousHash: string | null } {
    const row = readState(this.deps.db, enrollmentId);
    return {
      sequence: row?.journal_last_sequence ?? 0,
      previousHash: row?.journal_last_hash ?? null,
    };
  }

  getActiveStaffSignInId(enrollmentId: string): string | null {
    return readState(this.deps.db, enrollmentId)?.active_staff_sign_in_id ?? null;
  }

  /**
   * Quantities keyed by snapshot line id (batch id), for the installed snapshot: online (deduped)
   * plus offline ordinary_sale commands already appended.
   */
  getBatchUsageQuantities(enrollmentId: string): Record<string, number> {
    const scope = readSnapshotScope(this.deps.db, enrollmentId);
    if (!scope) return {};
    const rows = this.deps.db
      .prepare(
        `SELECT batch_id, qty_sold FROM offline_journal_batch_usage
         WHERE enrollment_id = ? AND snapshot_id = ? AND snapshot_version = ?`,
      )
      .all(enrollmentId, scope.snapshotId, scope.snapshotVersion) as { batch_id: string; qty_sold: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.batch_id] = r.qty_sold;
    return out;
  }

  /**
   * Starts one offline outage session when none is active (first transition with fresh snapshot check).
   */
  ensureOfflineOutageSession(
    enrollmentId: string,
    trustedNowMs: number,
  ): { offlineSessionId: string; offlineStartedAt: number } {
    // P5 #51: a store restored from a backup sells offline again only once the restore is
    // acknowledged and a pair issued after that is installed — not even in an outage the backup
    // was taken in: anything recorded after the backup is gone from this computer.
    if (storeRestoreBlocksOffline(this.deps.db, enrollmentId)) throw new Error("RECONCILIATION_REQUIRED");
    const row = readState(this.deps.db, enrollmentId);
    if (row?.offline_session_id && row.offline_started_at != null) {
      return { offlineSessionId: row.offline_session_id, offlineStartedAt: row.offline_started_at };
    }
    const installed = readInstalledOfflineAuthority(this.deps.db, enrollmentId);
    if (!installed) throw new Error("NO_OFFLINE_AUTHORITY");
    // P5 #51: a journal the server says differs from its own (a restored backup, damage) must be
    // recovered online before another outage starts on it.
    if (journalNeedsRecovery(this.deps.db, enrollmentId)) throw new Error("RECONCILIATION_REQUIRED");
    const snapshot = installed.snapshot.payload;
    const grant = installed.grant.payload;
    // #50: exactly maxSnapshotAgeAtOutageMs is accepted at outage start (strict > would reject 15:00).
    if (trustedNowMs - snapshot.generatedAt > grant.maxSnapshotAgeAtOutageMs) throw new Error("SNAPSHOT_STALE");
    if (trustedNowMs >= grant.expiresAt || trustedNowMs < grant.notBefore) throw new Error("GRANT_EXPIRED");
    const offlineSessionId = randomUUID();
    const offlineStartedAt = trustedNowMs;
    const tx = this.deps.db.transaction(() => {
      this.upsertStateRow(enrollmentId, (prev) => ({
        journal_last_sequence: prev?.journal_last_sequence ?? row?.journal_last_sequence ?? 0,
        journal_last_hash: prev?.journal_last_hash ?? row?.journal_last_hash ?? null,
        offline_session_id: offlineSessionId,
        offline_started_at: offlineStartedAt,
        active_staff_sign_in_id: prev?.active_staff_sign_in_id ?? row?.active_staff_sign_in_id ?? null,
        active_staff_envelope_json: prev?.active_staff_envelope_json ?? row?.active_staff_envelope_json ?? null,
      }));
    });
    tx();
    return { offlineSessionId, offlineStartedAt };
  }

  /**
   * Append a device-signed journal command: Ed25519 verify, identity vs grant/snapshot/device,
   * hash chain, duplicate commandId; ordinary_sale increments batch usage for this snapshot.
   */
  appendSignedCommand(envelope: Signed<OfflineJournalCommand>): void {
    const command = envelope.payload;
    const hash = journalCommandHash(command);
    const device = readEnrolledDevice(this.deps.db);
    if (!device) throw new Error("NO_DEVICE_KEY");

    verifyDeviceCommandSignature(envelope, device.publicKeyHex);
    if (envelope.keyId !== command.identity.keyId) throw new Error("INVALID_SIGNATURE");
    if (!sameTerminalIdentity(command.identity, device)) throw new Error("IDENTITY_MISMATCH");

    if (storeRestoreBlocksOffline(this.deps.db, command.identity.enrollmentId)) throw new Error("RECONCILIATION_REQUIRED");
    const installed = readInstalledOfflineAuthority(this.deps.db, command.identity.enrollmentId);
    if (!installed) throw new Error("NO_OFFLINE_AUTHORITY");
    const grant = installed.grant.payload;
    const snapshot = installed.snapshot.payload;
    if (!sameTerminalIdentity(command.identity, grant.identity) || !sameTerminalIdentity(command.identity, snapshot.identity))
      throw new Error("IDENTITY_MISMATCH");

    const at = this.atIso();
    const tx = this.deps.db.transaction(() => {
      const existingCmd = this.deps.db
        .prepare("SELECT payload_hash FROM offline_journal_command WHERE command_id = ?")
        .get(command.commandId) as { payload_hash: string } | undefined;
      if (existingCmd) {
        if (existingCmd.payload_hash !== hash) throw new Error("REPLAY_CONFLICT");
        return;
      }

      const head = readState(this.deps.db, command.identity.enrollmentId);
      const lastSeq = head?.journal_last_sequence ?? 0;
      const lastHash = head?.journal_last_hash ?? null;
      if (command.sequence !== lastSeq + 1) throw new Error("SEQUENCE_GAP");
      if (command.previousCommandHash !== lastHash) throw new Error("REPLAY_CONFLICT");

      this.deps.db
        .prepare(
          `INSERT INTO offline_journal_command
            (command_id, enrollment_id, sequence, previous_hash, payload_hash, envelope_json, sync_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          command.commandId,
          command.identity.enrollmentId,
          command.sequence,
          command.previousCommandHash,
          hash,
          JSON.stringify(envelope),
          at,
        );

      if (command.kind === "ordinary_sale") {
        const bump = this.deps.db.prepare(`
          INSERT INTO offline_journal_batch_usage
            (enrollment_id, snapshot_id, snapshot_version, batch_id, qty_sold)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (enrollment_id, snapshot_id, snapshot_version, batch_id) DO UPDATE SET
            qty_sold = offline_journal_batch_usage.qty_sold + excluded.qty_sold
        `);
        for (const line of command.lines) {
          if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) continue;
          bump.run(
            command.identity.enrollmentId,
            snapshot.snapshotId,
            snapshot.snapshotVersion,
            line.snapshotLineId,
            line.quantity,
          );
        }
      }

      this.upsertStateRow(command.identity.enrollmentId, () => ({
        journal_last_sequence: command.sequence,
        journal_last_hash: hash,
        offline_session_id: head?.offline_session_id ?? null,
        offline_started_at: head?.offline_started_at ?? null,
        active_staff_sign_in_id: head?.active_staff_sign_in_id ?? null,
        active_staff_envelope_json: head?.active_staff_envelope_json ?? null,
      }));
    });
    tx();
  }

  validateOrdinaryOfflineSalePolicy(input: {
    grant: OfflineGrant;
    snapshot: BranchStockSnapshot;
    sale: OfflineSaleCommand;
    trustedNow: number;
    terminalState: "offline";
    usageQuantities: Record<string, number>;
    offlineSessionId: string;
    offlineStartedAt: number;
    staffSignIn: OfflineStaffSignIn;
    openShift: LocalOpenTillShift | null;
  }): string | null {
    const offlineUsage = {
      grantId: input.grant.grantId,
      grantVersion: input.grant.grantVersion,
      snapshotId: input.snapshot.snapshotId,
      snapshotVersion: input.snapshot.snapshotVersion,
      offlineSessionId: input.offlineSessionId,
      offlineStartedAt: input.offlineStartedAt,
      quantities: input.usageQuantities,
    };
    return offlineSalePolicyError(
      input.grant,
      input.snapshot,
      input.sale,
      offlineUsage,
      input.trustedNow,
      input.terminalState,
      input.staffSignIn,
      input.openShift,
      undefined,
    );
  }

  private upsertStateRow(enrollmentId: string, build: (prev: JournalStateRow | null) => JournalStatePartial): void {
    const prev = readState(this.deps.db, enrollmentId);
    const next = build(prev);
    const updated_at = this.atIso();
    if (!prev) {
      this.deps.db
        .prepare(
          `INSERT INTO offline_journal_state (
            enrollment_id, journal_last_sequence, journal_last_hash,
            offline_session_id, offline_started_at, active_staff_sign_in_id, active_staff_envelope_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          enrollmentId,
          next.journal_last_sequence,
          next.journal_last_hash,
          next.offline_session_id,
          next.offline_started_at,
          next.active_staff_sign_in_id,
          next.active_staff_envelope_json,
          updated_at,
        );
    } else {
      this.deps.db
        .prepare(
          `UPDATE offline_journal_state SET
            journal_last_sequence = ?,
            journal_last_hash = ?,
            offline_session_id = ?,
            offline_started_at = ?,
            active_staff_sign_in_id = ?,
            active_staff_envelope_json = ?,
            updated_at = ?
           WHERE enrollment_id = ?`,
        )
        .run(
          next.journal_last_sequence,
          next.journal_last_hash,
          next.offline_session_id,
          next.offline_started_at,
          next.active_staff_sign_in_id,
          next.active_staff_envelope_json,
          updated_at,
          enrollmentId,
        );
    }
  }
}
