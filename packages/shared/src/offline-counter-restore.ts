import type { JournalPosition } from "./offline-journal-recovery";
import type { TerminalIdentity } from "./terminal-contracts";

/**
 * P5 #51: restoring a POS counter's encrypted store from one of its own backups (decisions of
 * 2026-11-10). Backups stay on the computer that took them, each under its own key that only the
 * same Windows user there can unlock, with staff PIN verifiers removed. Anyone at the computer may
 * restore, but only onto a store that cannot be opened or holds no counter, never over a working
 * one.
 *
 * Anything the counter recorded after the backup was taken and never uploaded is gone from it: a
 * restore can hide offline sales. So a restored counter reports the restore, and the server
 * refuses it offline authority until the owner or a delegated manager (revised D13) acknowledges
 * the restore in the back office, saying how receipts, cash and stock after the backup were
 * checked. Online selling carries on meanwhile, unless the backup was taken during an outage: that
 * outage's reconnect drain (D12) pauses online checkout until a fresh pair is installed, and no
 * pair is issued before the acknowledgement.
 */

/**
 * Device-signed (purpose `command`) once, on the first connection after a restore, and resent
 * unchanged until it is answered. Times are the counter's own clock (epoch milliseconds): they
 * say what the counter believes, the server's own `reportedAt` and last-contact time say the rest.
 */
export type OfflineCounterRestoreReport = Readonly<{
  contractVersion: 1;
  kind: "offline_counter_restore_report";
  /** Generated at restore: resending the same report returns the same restore. */
  restoreId: string;
  identity: TerminalIdentity;
  reportedAt: number;
  /** The backup restored, and when the counter took it. */
  backupId: string;
  backupTakenAt: number;
  restoredAt: number;
  /** The restored journal's last entry, and the last position the server had confirmed to it. */
  journalHead: JournalPosition;
  acceptedWatermark: JournalPosition;
  /** The backup was taken during an outage whose drain had not finished. */
  outageActive: boolean;
  /** The offline authority version the backup held, removed at restore; null if it held none. */
  removedGrantVersion: number | null;
}>;

/** `awaiting_acknowledgement` → `acknowledged`, once. */
export type CounterRestoreStatus = "awaiting_acknowledgement" | "acknowledged";

/**
 * What a counter is told about its own restore (`POST /terminals/offline-journal/restore/report`
 * and `…/status`).
 */
export type CounterStoreRestore = Readonly<{
  restoreId: string;
  status: CounterRestoreStatus;
  acknowledgedAt: number | null;
  /**
   * The highest offline authority version the server has issued this enrollment (0 if none). The
   * restored counter never installs a pair at or below it: any such pair was superseded while the
   * backup was all this computer had.
   */
  latestGrantVersion: number;
}>;

/** `POST /terminals/offline-journal/restore/status`. */
export type CounterRestoreStatusRequest = Readonly<{
  identity: TerminalIdentity;
  restoreId: string;
}>;

/** `GET /offline-counter-restores`, one restore. Times are epoch milliseconds. */
export type OfflineCounterRestoreView = Readonly<{
  id: string;
  restoreId: string;
  status: CounterRestoreStatus;
  terminalId: string;
  terminalLabel: string | null;
  enrollmentId: string;
  /** Server time the report arrived. */
  reportedAt: number;
  /** The counter's own clock. */
  backupTakenAt: number;
  restoredAt: number;
  journalHead: JournalPosition;
  /** The server's accepted head when the report arrived. */
  serverHead: JournalPosition;
  outageActive: boolean;
  removedGrantVersion: number | null;
  latestGrantVersion: number;
  /**
   * The last time the server heard from this counter before the report (a sign-in, a signed
   * command, a journal upload or an offline authority issuance), or null. Offline sales made after
   * the later of this and `backupTakenAt`, and never uploaded, are lost from the counter.
   */
  lastContactAt: number | null;
  acknowledgement: Readonly<{
    acknowledgedByUserId: string;
    acknowledgedByFullName: string | null;
    acknowledgedAt: number;
    reason: string;
    authority: "owner" | "delegated_manager";
  }> | null;
}>;

export type OfflineCounterRestoresView = Readonly<{
  branchId: string;
  /** Restores awaiting acknowledgement first, then the newest 20 others. */
  restores: ReadonlyArray<OfflineCounterRestoreView>;
}>;

/** `POST /offline-counter-restores/:id/acknowledge`. */
export type AcknowledgeCounterRestoreRequest = Readonly<{
  /** How receipts, cash and stock after the backup were checked, or why nothing was missing. */
  reason: string;
}>;
