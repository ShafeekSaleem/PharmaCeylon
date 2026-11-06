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

export function journalCommandHash(payload: unknown): string {
  return createHash("sha256")
    .update(terminalSigningText("command", payload), "utf8")
    .digest("hex");
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

  private nowMs() {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  /** After a successful PIN sign-in at the counter, while online authority is installed. */
  recordStaffSignInFromPin(options: {
    enrollmentId: string;
    identity: TerminalIdentity;
    registerId: string;
    tillId: string;
    session: { workSessionId: string; staffUserId: string };
    key: { sign: <T>(payload: T, purpose: "command") => Signed<T> };
  }): Signed<OfflineStaffSignIn> | null {
    const installed = readInstalledOfflineAuthority(this.deps.db, options.enrollmentId);
    if (!installed) return null;
    const grant = installed.grant.payload;
    const staff = grant.authorizedStaff.find((s) => s.staffUserId === options.session.staffUserId);
    if (!staff) return null;

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
    const at = new Date().toISOString();
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
   * Online sales on this terminal consume snapshot batches before the watermark; journal commits
   * must include this usage in `offlineSalePolicyError` / LOCAL_STOCK_EXHAUSTED checks.
   */
  recordOnlineSaleBatchUsage(
    enrollmentId: string,
    lines: ReadonlyArray<{ batchId: string; qty: number }>,
  ): void {
    if (!lines.length) return;
    const tx = this.deps.db.transaction(() => {
      const bump = this.deps.db.prepare(`
        INSERT INTO offline_journal_batch_usage (enrollment_id, batch_id, qty_sold)
        VALUES (?, ?, ?)
        ON CONFLICT (enrollment_id, batch_id) DO UPDATE SET
          qty_sold = offline_journal_batch_usage.qty_sold + excluded.qty_sold
      `);
      for (const line of lines) {
        if (!line.batchId || !Number.isSafeInteger(line.qty) || line.qty <= 0) continue;
        bump.run(enrollmentId, line.batchId, line.qty);
      }
    });
    tx();
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

  /** Quantities keyed by snapshot line id (here: batch id), including online sales on this terminal. */
  getBatchUsageQuantities(enrollmentId: string): Record<string, number> {
    const rows = this.deps.db
      .prepare(
        "SELECT batch_id, qty_sold FROM offline_journal_batch_usage WHERE enrollment_id = ?",
      )
      .all(enrollmentId) as { batch_id: string; qty_sold: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.batch_id] = r.qty_sold;
    return out;
  }

  /**
   * Starts one offline outage session when none is active (first transition with fresh snapshot check).
   * Callers supply trusted time; original outage uses snapshot freshness vs offlineStartedAt.
   */
  ensureOfflineOutageSession(enrollmentId: string, trustedNowMs: number): { offlineSessionId: string; offlineStartedAt: number } {
    const row = readState(this.deps.db, enrollmentId);
    if (row?.offline_session_id && row.offline_started_at != null) {
      return { offlineSessionId: row.offline_session_id, offlineStartedAt: row.offline_started_at };
    }
    const installed = readInstalledOfflineAuthority(this.deps.db, enrollmentId);
    if (!installed) throw new Error("No offline authority installed");
    const snapshot = installed.snapshot.payload;
    const grant = installed.grant.payload;
    if (trustedNowMs - snapshot.generatedAt > grant.maxSnapshotAgeAtOutageMs)
      throw new Error("SNAPSHOT_STALE");
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
   * Append a device-signed journal command: verifies hash chain and persists atomically with head.
   * Does not re-verify Ed25519 (caller must use device key); validates sequence/link only.
   */
  appendSignedCommand(envelope: Signed<OfflineJournalCommand>): void {
    const command = envelope.payload;
    const hash = journalCommandHash(command);
    if (envelope.keyId !== command.identity.keyId) throw new Error("key mismatch");
    const at = new Date().toISOString();
    const tx = this.deps.db.transaction(() => {
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

  /**
   * Pure policy check using shared `offlineSalePolicyError`; caller supplies trusted time and
   * optional offline session (outage) ids consistent with stored state.
   */
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
    const updated_at = new Date().toISOString();
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

export function assertSnapshotFreshAtOutage(snapshotGeneratedAt: number, offlineStartedAt: number): boolean {
  return offlineStartedAt - snapshotGeneratedAt <= MAX_SNAPSHOT_AGE_AT_OUTAGE_MS;
}

export function grantWithinValidity(grantNotBefore: number, grantExpiresAt: number, trustedNow: number): boolean {
  return trustedNow >= grantNotBefore && trustedNow < grantExpiresAt;
}
