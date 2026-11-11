import { randomUUID } from "node:crypto";
import {
  JOURNAL_CHAIN_PAGE_MAX,
  JOURNAL_RECOVERY_PAGE_MAX,
  type CounterJournalRecovery,
  type JournalPosition,
  type OfflineJournalChainPage,
  type OfflineJournalCommand,
  type OfflineJournalRecoveryCompletion,
  type OfflineJournalRecoveryReport,
  type OfflineStaffSignIn,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import type { DeviceKey } from "../device/device-key";
import { verifyDeviceCommandSignature } from "./device-signature";
import { localJournalHashAt, localJournalHead } from "./offline-journal";
import {
  journalCommandHash,
  resetJournalUsageForEnrollment,
} from "./offline-journal-writer";
import {
  ensureSyncRow,
  journalNeedsRecovery,
  recordAcceptedWatermark,
  readAcceptedWatermark,
} from "./reconnect-drain";
import type { TerminalService } from "./terminal-service";

/**
 * P5 #51, approved D11 (decisions of 2026-11-10): recovering this counter's journal when the
 * server's signed reply says it is not the server's (`JOURNAL_MISMATCH` — a restored backup, a
 * damaged journal). Runs only while that issue stands and someone is signed in.
 *
 * 1. Read the server's accepted chain from this computer's own accepted watermark. Every entry is
 *    one this device signed, so each is checked against this device's key and the chain itself:
 *    the server can withhold entries, never invent them. The last entry both journals share is
 *    the common prefix; this computer's entries after it are unmatched.
 * 2. Report, device-signed, with the unmatched entries (and the sign-ins they cite) in pages. The
 *    report is stored first and resent unchanged until it is answered, so a lost reply never
 *    opens a second recovery.
 * 3. Wait for the owner or a delegated manager to approve it in the back office.
 * 4. Apply it in one local transaction: set the unmatched entries aside (kept for good), restore
 *    the server's entries after the common prefix, move the journal head and the accepted
 *    watermark to the server's head, remove the installed offline grant and snapshot (and any
 *    pending renewal request), and clear the issue. Then confirm with a device-signed completion.
 *
 * This counter never writes an entry at a sequence the server has accepted, and never sells
 * offline again on authority it held before: only a pair the server issues after the completion
 * is installed. Unmatched entries are evidence, never sales, here and on the server.
 */
const CHAIN_PATH = "/terminals/offline-journal/recovery/chain";
const REPORT_PATH = "/terminals/offline-journal/recovery/report";
const STATUS_PATH = "/terminals/offline-journal/recovery/status";
const completePath = (recoveryId: string) =>
  `/terminals/offline-journal/recovery/${recoveryId}/complete`;

/** Pages of the server's chain read in one survey (100 entries each). */
const MAX_CHAIN_PAGES = 50;
const FIRST_BACKOFF_MS = 15_000;
const BACKOFF_CAP_MS = 15 * 60_000;
/** While waiting for approval, ask this often. */
export const RECOVERY_POLL_MS = 60_000;

const isOpen = (status: CounterJournalRecovery["status"]) =>
  status === "awaiting_approval" || status === "approved";

/** Server refusals meaning the recovery this computer holds is over: report afresh. */
const START_OVER = new Set([
  "JOURNAL_RECOVERY_STALE",
  "JOURNAL_RECOVERY_NOT_APPROVED",
]);

export type LocalRecoveryStatus =
  | "reporting"
  | "awaiting_approval"
  | "approved"
  | "applied"
  | "recovered";

export type LocalJournalRecovery = {
  reportId: string;
  report: Signed<OfflineJournalRecoveryReport>;
  recoveryId: string | null;
  status: LocalRecoveryStatus;
  serverHead: JournalPosition;
  commonPrefix: JournalPosition;
  localHead: JournalPosition;
  completion: Signed<OfflineJournalRecoveryCompletion> | null;
  appliedAt: string | null;
  completedAt: string | null;
};

type RecoveryRow = {
  report_id: string;
  report_envelope: string;
  recovery_id: string | null;
  status: LocalRecoveryStatus;
  server_head_sequence: number;
  server_head_hash: string | null;
  common_sequence: number;
  common_hash: string | null;
  local_head_sequence: number;
  local_head_hash: string | null;
  completion_envelope: string | null;
  applied_at: string | null;
  completed_at: string | null;
};

type CommandRow = {
  sequence: number;
  payload_hash: string;
  envelope_json: string;
};

/** A chain the server handed back that this computer cannot verify. Nothing in it is used. */
export class JournalRecoveryInvalid extends Error {
  readonly code = "JOURNAL_RECOVERY_INVALID";
  constructor(reason: string) {
    super(`Journal recovery refused: ${reason}`);
    this.name = "JournalRecoveryInvalid";
  }
}

const samePosition = (a: JournalPosition, b: JournalPosition) =>
  a.sequence === b.sequence && a.hash === b.hash;
const identityKeys = [
  "tenantId",
  "branchId",
  "terminalId",
  "enrollmentId",
  "keyId",
] as const;
const sameIdentity = (a: TerminalIdentity, b: TerminalIdentity) =>
  identityKeys.every((k) => a[k] === b[k]);

/** This enrollment's current recovery, from the local store. */
export function readLocalRecovery(
  db: PosDatabase,
  enrollmentId: string,
): LocalJournalRecovery | null {
  const row = db
    .prepare(
      `SELECT report_id, report_envelope, recovery_id, status, server_head_sequence, server_head_hash,
              common_sequence, common_hash, local_head_sequence, local_head_hash, completion_envelope,
              applied_at, completed_at
       FROM offline_journal_recovery WHERE enrollment_id = ?`,
    )
    .get(enrollmentId) as RecoveryRow | undefined;
  if (!row) return null;
  return {
    reportId: row.report_id,
    report: JSON.parse(
      row.report_envelope,
    ) as Signed<OfflineJournalRecoveryReport>,
    recoveryId: row.recovery_id,
    status: row.status,
    serverHead: {
      sequence: row.server_head_sequence,
      hash: row.server_head_hash,
    },
    commonPrefix: { sequence: row.common_sequence, hash: row.common_hash },
    localHead: { sequence: row.local_head_sequence, hash: row.local_head_hash },
    completion: row.completion_envelope
      ? (JSON.parse(
          row.completion_envelope,
        ) as Signed<OfflineJournalRecoveryCompletion>)
      : null,
    appliedAt: row.applied_at,
    completedAt: row.completed_at,
  };
}

/** Plain words for the counter while a recovery is under way, or null when there is none. */
export function explainRecovery(
  recovery: LocalJournalRecovery | null,
): string | null {
  switch (recovery?.status) {
    case "reporting":
      return "This computer's offline records differ from the server's. It is sending them to the back office for review. Don't sell offline here.";
    case "awaiting_approval":
      return "This computer's offline records differ from the server's. An owner or manager reviews them in the back office (Settings → Offline policy). Don't sell offline here.";
    case "approved":
    case "applied":
      return "The back office approved restoring this counter's offline records. It finishes by itself.";
    default:
      return null;
  }
}

/** Entries this computer set aside in recoveries: kept as evidence, never uploaded as sales. */
export function setAsideEntries(
  db: PosDatabase,
  enrollmentId: string,
): { recoveryId: string; sequence: number; commandId: string }[] {
  return (
    db
      .prepare(
        `SELECT recovery_id, sequence, command_id FROM offline_journal_set_aside
         WHERE enrollment_id = ? ORDER BY set_aside_at, sequence`,
      )
      .all(enrollmentId) as {
      recovery_id: string;
      sequence: number;
      command_id: string;
    }[]
  ).map((r) => ({
    recoveryId: r.recovery_id,
    sequence: r.sequence,
    commandId: r.command_id,
  }));
}

export type JournalRecoveryDeps = {
  db: PosDatabase;
  api: Pick<ApiSession, "request">;
  terminal: Pick<TerminalService, "current">;
  report: (error: unknown) => void;
  now?: () => number;
};

/** What one look did, for the reconnect coordinator. */
export type RecoveryTick = "idle" | "waiting" | "recovered";

export function createJournalRecovery(deps: JournalRecoveryDeps) {
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  let inFlight = false;
  let failures = 0;
  let nextAttemptAt: number | null = null;

  function store(enrollmentId: string, recovery: LocalJournalRecovery): void {
    deps.db
      .prepare(
        `INSERT INTO offline_journal_recovery (
           enrollment_id, report_id, report_envelope, recovery_id, status, server_head_sequence, server_head_hash,
           common_sequence, common_hash, local_head_sequence, local_head_hash, completion_envelope,
           applied_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (enrollment_id) DO UPDATE SET
           report_id = excluded.report_id, report_envelope = excluded.report_envelope,
           recovery_id = excluded.recovery_id, status = excluded.status,
           server_head_sequence = excluded.server_head_sequence, server_head_hash = excluded.server_head_hash,
           common_sequence = excluded.common_sequence, common_hash = excluded.common_hash,
           local_head_sequence = excluded.local_head_sequence, local_head_hash = excluded.local_head_hash,
           completion_envelope = excluded.completion_envelope, applied_at = excluded.applied_at,
           completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
      )
      .run(
        enrollmentId,
        recovery.reportId,
        JSON.stringify(recovery.report),
        recovery.recoveryId,
        recovery.status,
        recovery.serverHead.sequence,
        recovery.serverHead.hash,
        recovery.commonPrefix.sequence,
        recovery.commonPrefix.hash,
        recovery.localHead.sequence,
        recovery.localHead.hash,
        recovery.completion ? JSON.stringify(recovery.completion) : null,
        recovery.appliedAt,
        recovery.completedAt,
        iso(),
      );
  }

  function forget(enrollmentId: string): void {
    deps.db
      .prepare("DELETE FROM offline_journal_recovery WHERE enrollment_id = ?")
      .run(enrollmentId);
  }

  /** The staff sign-ins the entries cite: each entry's own, and an assisted close's manager. */
  function citedSignIns(
    enrollmentId: string,
    commands: ReadonlyArray<Signed<OfflineJournalCommand>>,
  ): Signed<OfflineStaffSignIn>[] {
    const ids = new Set<string>();
    for (const { payload } of commands) {
      ids.add(payload.staffSignInId);
      if (payload.kind === "shift_close" && payload.assistance)
        ids.add(payload.assistance.managerSignInId);
    }
    const read = deps.db.prepare(
      "SELECT envelope_json FROM offline_journal_staff_sign_in WHERE enrollment_id = ? AND staff_sign_in_id = ?",
    );
    const found: Signed<OfflineStaffSignIn>[] = [];
    for (const id of ids) {
      const row = read.get(enrollmentId, id) as
        | { envelope_json: string }
        | undefined;
      if (row)
        found.push(JSON.parse(row.envelope_json) as Signed<OfflineStaffSignIn>);
    }
    return found;
  }

  function unmatchedRows(enrollmentId: string, after: number): CommandRow[] {
    return deps.db
      .prepare(
        `SELECT sequence, payload_hash, envelope_json FROM offline_journal_command
         WHERE enrollment_id = ? AND sequence > ? ORDER BY sequence`,
      )
      .all(enrollmentId, after) as CommandRow[];
  }

  /**
   * The server's accepted chain after `from`, every entry and sign-in verified as this device's
   * own and chained from `from`, through the head the server names. Also the last entry the two
   * journals share, starting from `from` (which both have).
   */
  async function readChain(
    identity: TerminalIdentity,
    publicKeyHex: string,
    from: JournalPosition,
  ) {
    const entries: { envelope: Signed<OfflineJournalCommand>; hash: string }[] =
      [];
    const signIns = new Map<string, Signed<OfflineStaffSignIn>>();
    let at = from;
    let common = from;
    let diverged = false;
    for (let page = 0; page < MAX_CHAIN_PAGES; page++) {
      const reply = await deps.api.request<OfflineJournalChainPage>(
        "POST",
        CHAIN_PATH,
        {
          branchId: identity.branchId,
          body: {
            identity,
            afterSequence: at.sequence,
            limit: JOURNAL_CHAIN_PAGE_MAX,
          },
        },
      );
      if (
        !reply ||
        !Array.isArray(reply.entries) ||
        !Array.isArray(reply.staffSignIns) ||
        !reply.head
      )
        throw new JournalRecoveryInvalid("page");
      for (const envelope of reply.entries) {
        const payload = envelope?.payload;
        if (!payload || !sameIdentity(payload.identity, identity))
          throw new JournalRecoveryInvalid("identity");
        try {
          verifyDeviceCommandSignature(envelope, publicKeyHex);
        } catch {
          throw new JournalRecoveryInvalid("signature");
        }
        const hash = journalCommandHash(payload);
        if (
          payload.sequence !== at.sequence + 1 ||
          payload.previousCommandHash !== at.hash
        )
          throw new JournalRecoveryInvalid("chain");
        at = { sequence: payload.sequence, hash };
        if (
          !diverged &&
          localJournalHashAt(
            deps.db,
            identity.enrollmentId,
            payload.sequence,
          ) === hash
        )
          common = at;
        else {
          diverged = true;
          entries.push({ envelope, hash });
        }
      }
      for (const envelope of reply.staffSignIns) {
        if (
          !envelope?.payload ||
          !sameIdentity(envelope.payload.identity, identity)
        )
          throw new JournalRecoveryInvalid("identity");
        try {
          verifyDeviceCommandSignature(envelope, publicKeyHex);
        } catch {
          throw new JournalRecoveryInvalid("signature");
        }
        signIns.set(envelope.payload.staffSignInId, envelope);
      }
      if (
        at.sequence >= reply.head.sequence ||
        reply.entries.length < JOURNAL_CHAIN_PAGE_MAX
      ) {
        // The head must be exactly the last verified entry: nothing withheld past it.
        if (!samePosition(at, reply.head))
          throw new JournalRecoveryInvalid("head");
        return { head: at, common, entries, signIns };
      }
    }
    throw new JournalRecoveryInvalid("too_long");
  }

  async function sendPages(
    identity: TerminalIdentity,
    recovery: LocalJournalRecovery,
    received: number,
  ): Promise<CounterJournalRecovery> {
    const rows = unmatchedRows(
      identity.enrollmentId,
      recovery.commonPrefix.sequence,
    ).filter((r) => r.sequence <= recovery.localHead.sequence);
    let offset = received;
    for (;;) {
      const page = rows
        .slice(offset, offset + JOURNAL_RECOVERY_PAGE_MAX)
        .map(
          (r) => JSON.parse(r.envelope_json) as Signed<OfflineJournalCommand>,
        );
      const reply = await deps.api.request<CounterJournalRecovery>(
        "POST",
        REPORT_PATH,
        {
          branchId: identity.branchId,
          body: {
            report: recovery.report,
            unmatched: page,
            staffSignIns: citedSignIns(identity.enrollmentId, page),
          },
        },
      );
      if (reply.reportId !== recovery.reportId)
        throw new JournalRecoveryInvalid("report");
      if (reply.status !== "awaiting_approval" || reply.received >= rows.length)
        return reply;
      if (reply.received <= offset) throw new JournalRecoveryInvalid("upload");
      offset = reply.received;
    }
  }

  /** Report the difference: stored first, so a lost reply resends the same report. */
  async function report(
    identity: TerminalIdentity,
    key: DeviceKey,
    existing: LocalJournalRecovery | null,
  ): Promise<RecoveryTick> {
    const enrollmentId = identity.enrollmentId;
    const accepted = readAcceptedWatermark(deps.db, enrollmentId);
    const chain = await readChain(identity, key.publicKeyHex, accepted);
    const localHead = localJournalHead(deps.db, enrollmentId);
    // Every accepted entry is here: the journal is only behind, and the upload continues it.
    if (chain.common.sequence === chain.head.sequence) {
      if (existing) forget(enrollmentId);
      return "idle";
    }
    let recovery = existing;
    if (
      !recovery ||
      recovery.status !== "reporting" ||
      !samePosition(recovery.serverHead, chain.head) ||
      !samePosition(recovery.commonPrefix, chain.common) ||
      !samePosition(recovery.localHead, localHead)
    ) {
      const payload: OfflineJournalRecoveryReport = {
        contractVersion: 1,
        kind: "offline_journal_recovery_report",
        reportId: randomUUID(),
        identity,
        reportedAt: now(),
        serverHead: chain.head,
        commonPrefix: chain.common,
        localHead,
      };
      recovery = {
        reportId: payload.reportId,
        report: key.sign(payload, "command"),
        recoveryId: null,
        status: "reporting",
        serverHead: chain.head,
        commonPrefix: chain.common,
        localHead,
        completion: null,
        appliedAt: null,
        completedAt: null,
      };
      store(enrollmentId, recovery);
    }
    const reply = await sendPages(identity, recovery, 0);
    return adopt(identity, key, recovery, reply);
  }

  /** Record what the server says about this computer's recovery, and act on it. */
  async function adopt(
    identity: TerminalIdentity,
    key: DeviceKey,
    recovery: LocalJournalRecovery,
    reply: CounterJournalRecovery,
  ): Promise<RecoveryTick> {
    const enrollmentId = identity.enrollmentId;
    if (!isOpen(reply.status)) {
      // Over, without this computer applying it: a newer report, the server's journal moved, or
      // the owner closed it.
      forget(enrollmentId);
      return "waiting";
    }
    if (
      !samePosition(reply.serverHead, recovery.serverHead) ||
      !samePosition(reply.commonPrefix, recovery.commonPrefix) ||
      !samePosition(reply.localHead, recovery.localHead)
    )
      throw new JournalRecoveryInvalid("positions");
    const next = {
      ...recovery,
      recoveryId: reply.recoveryId,
      status: reply.status,
    };
    store(enrollmentId, next);
    if (reply.status === "awaiting_approval") {
      if (reply.received < reply.unmatched)
        await sendPages(identity, next, reply.received);
      return "waiting";
    }
    return apply(identity, key, next);
  }

  /** Apply an approved recovery in one transaction, then confirm it. */
  async function apply(
    identity: TerminalIdentity,
    key: DeviceKey,
    recovery: LocalJournalRecovery,
  ): Promise<RecoveryTick> {
    const enrollmentId = identity.enrollmentId;
    // Recorded more offline sales since reporting (an outage that was already running): those
    // need review too, so report again; the server supersedes the approved recovery.
    if (
      !samePosition(localJournalHead(deps.db, enrollmentId), recovery.localHead)
    ) {
      forget(enrollmentId);
      return "waiting";
    }
    const chain = await readChain(
      identity,
      key.publicKeyHex,
      recovery.commonPrefix,
    );
    // The server's journal moved since approval: its next status answer supersedes this one.
    if (
      !samePosition(chain.head, recovery.serverHead) ||
      !samePosition(chain.common, recovery.commonPrefix)
    )
      return "waiting";
    const completion = key.sign<OfflineJournalRecoveryCompletion>(
      {
        contractVersion: 1,
        kind: "offline_journal_recovery_completion",
        recoveryId: recovery.recoveryId!,
        identity,
        completedAt: now(),
        journalHead: recovery.serverHead,
        setAsideThrough: recovery.localHead,
        offlineAuthorityRemoved: true,
      },
      "command",
    );
    const db = deps.db;
    const applied = db
      .transaction((): boolean => {
        if (
          !samePosition(localJournalHead(db, enrollmentId), recovery.localHead)
        )
          return false;
        const at = iso();
        const after = recovery.commonPrefix.sequence;
        db.prepare(
          `INSERT INTO offline_journal_set_aside (
             command_id, enrollment_id, recovery_id, report_id, sequence, previous_hash, payload_hash, envelope_json,
             sync_status, acknowledgement_json, last_error_code, created_at, set_aside_at)
           SELECT command_id, enrollment_id, ?, ?, sequence, previous_hash, payload_hash, envelope_json,
                  sync_status, acknowledgement_json, last_error_code, created_at, ?
           FROM offline_journal_command WHERE enrollment_id = ? AND sequence > ?`,
        ).run(recovery.recoveryId, recovery.reportId, at, enrollmentId, after);
        db.prepare(
          "DELETE FROM offline_journal_command WHERE enrollment_id = ? AND sequence > ?",
        ).run(enrollmentId, after);
        const insert = db.prepare(
          `INSERT INTO offline_journal_command (
             command_id, enrollment_id, sequence, previous_hash, payload_hash, envelope_json, sync_status, created_at,
             acknowledgement_json, acknowledged_at)
           VALUES (?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?)`,
        );
        const restored = JSON.stringify({
          restoredByRecoveryId: recovery.recoveryId,
        });
        for (const { envelope, hash } of chain.entries)
          insert.run(
            envelope.payload.commandId,
            enrollmentId,
            envelope.payload.sequence,
            envelope.payload.previousCommandHash,
            hash,
            JSON.stringify(envelope),
            at,
            restored,
            at,
          );
        const signIn = db.prepare(
          `INSERT INTO offline_journal_staff_sign_in (staff_sign_in_id, enrollment_id, envelope_json, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (staff_sign_in_id) DO NOTHING`,
        );
        for (const [id, envelope] of chain.signIns)
          signIn.run(id, enrollmentId, JSON.stringify(envelope), at);
        // The journal continues at the server's head; no offline sign-in carries over.
        db.prepare(
          `INSERT INTO offline_journal_state (enrollment_id, journal_last_sequence, journal_last_hash, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (enrollment_id) DO UPDATE SET journal_last_sequence = excluded.journal_last_sequence,
             journal_last_hash = excluded.journal_last_hash, active_staff_sign_in_id = NULL,
             active_staff_envelope_json = NULL, updated_at = excluded.updated_at`,
        ).run(
          enrollmentId,
          recovery.serverHead.sequence,
          recovery.serverHead.hash,
          at,
        );
        if (!recordAcceptedWatermark(db, enrollmentId, recovery.serverHead, at))
          throw new JournalRecoveryInvalid("watermark");
        // Never sell again on authority held before the recovery; a restored renewal request
        // could only replay a pair from before it.
        db.prepare("DELETE FROM offline_authority WHERE enrollment_id = ?").run(
          enrollmentId,
        );
        db.prepare(
          "DELETE FROM offline_authority_request WHERE enrollment_id = ?",
        ).run(enrollmentId);
        resetJournalUsageForEnrollment(db, enrollmentId);
        ensureSyncRow(db, enrollmentId, at);
        db.prepare(
          `UPDATE offline_journal_sync SET issue_code = NULL, issue_message = NULL, issue_sequence = NULL, issue_at = NULL,
             updated_at = ? WHERE enrollment_id = ?`,
        ).run(at, enrollmentId);
        store(enrollmentId, {
          ...recovery,
          status: "applied",
          completion,
          appliedAt: at,
        });
        return true;
      })
      .immediate();
    if (!applied) {
      forget(enrollmentId);
      return "waiting";
    }
    return confirm(identity, readLocalRecovery(db, enrollmentId)!);
  }

  /** Tell the server the approved recovery is applied (resent until it answers). */
  async function confirm(
    identity: TerminalIdentity,
    recovery: LocalJournalRecovery,
  ): Promise<RecoveryTick> {
    const enrollmentId = identity.enrollmentId;
    try {
      const reply = await deps.api.request<CounterJournalRecovery>(
        "POST",
        completePath(recovery.recoveryId!),
        {
          branchId: identity.branchId,
          body: { completion: recovery.completion },
        },
      );
      if (
        reply.recoveryId !== recovery.recoveryId ||
        reply.status !== "recovered"
      )
        throw new JournalRecoveryInvalid("completion");
    } catch (error) {
      // The server's journal moved after approval: this computer's head is now a prefix of it,
      // and the next sync reports that as a new (smaller) recovery.
      if (error instanceof ApiError && START_OVER.has(error.code)) {
        forget(enrollmentId);
        return "waiting";
      }
      throw error;
    }
    store(enrollmentId, {
      ...recovery,
      status: "recovered",
      completedAt: iso(),
    });
    return "recovered";
  }

  /** The server's view of this counter's latest recovery, told where this journal is now. */
  function askStatus(
    identity: TerminalIdentity,
  ): Promise<CounterJournalRecovery | null> {
    return deps.api.request<CounterJournalRecovery | null>(
      "POST",
      STATUS_PATH,
      {
        branchId: identity.branchId,
        body: {
          identity,
          localHead: localJournalHead(deps.db, identity.enrollmentId),
        },
      },
    );
  }

  async function step(): Promise<RecoveryTick> {
    const current = deps.terminal.current();
    if (!current) return "idle";
    const { identity, key } = current;
    const enrollmentId = identity.enrollmentId;
    const recovery = readLocalRecovery(deps.db, enrollmentId);
    if (recovery?.status === "applied") return confirm(identity, recovery);
    if (!journalNeedsRecovery(deps.db, enrollmentId)) {
      // Nothing to recover any more (restored again, or the journal now matches the server's).
      // A recovery this computer reported is moot: tell the server where the journal is now, so
      // it supersedes the recovery rather than hold this counter's offline authority with it.
      // Matched by report, so a report whose reply was lost is asked about too.
      if (!recovery || recovery.status === "recovered") return "idle";
      const status = await askStatus(identity);
      if (
        status &&
        status.reportId === recovery.reportId &&
        isOpen(status.status)
      )
        return "waiting";
      forget(enrollmentId);
      return "idle";
    }
    if (
      recovery &&
      (recovery.status === "awaiting_approval" ||
        recovery.status === "approved")
    ) {
      const status = await askStatus(identity);
      if (
        status &&
        status.recoveryId === recovery.recoveryId &&
        isOpen(status.status)
      )
        return adopt(identity, key, recovery, status);
      // Over (the server's journal moved, a newer report, or closed): report what is true now.
      forget(enrollmentId);
      return report(identity, key, null);
    }
    return report(
      identity,
      key,
      recovery?.status === "reporting" ? recovery : null,
    );
  }

  return {
    /** One look. Never throws: failures are reported and delay the next attempt. */
    async tick(): Promise<RecoveryTick> {
      if (inFlight || (nextAttemptAt !== null && now() < nextAttemptAt))
        return "idle";
      inFlight = true;
      try {
        const result = await step();
        failures = 0;
        nextAttemptAt = result === "waiting" ? now() + RECOVERY_POLL_MS : null;
        return result;
      } catch (error) {
        failures += 1;
        nextAttemptAt =
          now() +
          Math.min(BACKOFF_CAP_MS, FIRST_BACKOFF_MS * 2 ** (failures - 1));
        deps.report(error);
        return "idle";
      } finally {
        inFlight = false;
      }
    },
    /** Look again at the next tick whatever the wait (a new mismatch was just recorded). */
    lookNow(): void {
      nextAttemptAt = null;
    },
  };
}

export type JournalRecovery = ReturnType<typeof createJournalRecovery>;
