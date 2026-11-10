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

/** How far ahead of the server a counter's clock may run before a restore view flags it. */
export const COUNTER_CLOCK_TOLERANCE_MS = 5 * 60_000;

/**
 * `clockSkew` of a restore view: both times are the counter's own clock, `reportedAt` the server's.
 * A restore happens before its report, so a counter time after `reportedAt` is a fast clock.
 */
export function counterRestoreClockSkew(times: {
  backupTakenAt: number;
  restoredAt: number;
  reportedAt: number;
}): OfflineCounterRestoreView["clockSkew"] {
  const backupAfterRestoreMs = Math.max(
    0,
    times.backupTakenAt - times.restoredAt,
  );
  const ahead =
    Math.max(times.backupTakenAt, times.restoredAt) - times.reportedAt;
  const aheadOfServerMs = ahead > COUNTER_CLOCK_TOLERANCE_MS ? ahead : 0;
  return backupAfterRestoreMs || aheadOfServerMs
    ? { backupAfterRestoreMs, aheadOfServerMs }
    : null;
}

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
   * command, a journal upload or an offline authority issuance), or null. It does not prove the
   * offline journal had been uploaded up to then: a sign-in during an unfinished drain counts. So
   * what may be missing is reckoned from `backupTakenAt`, never from this.
   */
  lastContactAt: number | null;
  /**
   * The counter's own clock disagreed, or null (P5 #51). `backupAfterRestoreMs`: its backup is
   * dated after its restore (a reset CMOS clock, or a fast clock corrected since the backup).
   * `aheadOfServerMs`: it dated the backup or the restore later than the server received the
   * report, beyond `COUNTER_CLOCK_TOLERANCE_MS`. The counter's times above are then unreliable,
   * and so is any window reckoned from them. Derived from the recorded report, which never changes.
   */
  clockSkew: Readonly<{
    backupAfterRestoreMs: number;
    aheadOfServerMs: number;
  }> | null;
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
