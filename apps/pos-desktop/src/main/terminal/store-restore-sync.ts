import type {
  CounterStoreRestore,
  OfflineCounterRestoreReport,
  Signed,
} from "@pharmaceylon/shared";
import { ApiError, type ApiSession } from "../api/api-client";
import type { PosDatabase } from "../db/database";
import type { TerminalService } from "./terminal-service";

/**
 * P5 #51: the restored counter's side of a store restore (decisions of 2026-11-10), after
 * `applyRestoreGuards` recorded it in `store_restore`.
 *
 * On each sync cycle while someone is signed in: send the restore's device-signed report (the
 * same envelope every time, so a lost reply never records a second restore), then ask how it
 * stands until the owner or a delegated manager has acknowledged it in the back office. The
 * server's answer carries the highest offline authority version it has issued this enrollment;
 * the installer never takes a pair at or below it again.
 *
 * A restore stops blocking offline selling only when a pair issued after the acknowledgement is
 * installed (`clearAcknowledgedRestores`, in the install's transaction).
 */
const REPORT_PATH = "/terminals/offline-journal/restore/report";
const STATUS_PATH = "/terminals/offline-journal/restore/status";
/** While waiting for the back office, ask this often. */
export const RESTORE_POLL_MS = 60_000;
const FIRST_BACKOFF_MS = 15_000;
const BACKOFF_CAP_MS = 15 * 60_000;

type Status =
  | "reporting"
  | "awaiting_acknowledgement"
  | "acknowledged"
  | "cleared";

type Row = {
  restore_id: string;
  enrollment_id: string;
  backup_taken_at: number;
  restored_at: number;
  status: Status;
  report_envelope: string;
  latest_grant_version: number | null;
  acknowledged_at: string | null;
};

export type LocalStoreRestore = {
  restoreId: string;
  status: Status;
  backupTakenAt: number;
  restoredAt: number;
  acknowledgedAt: string | null;
  latestGrantVersion: number | null;
};

const toLocal = (row: Row): LocalStoreRestore => ({
  restoreId: row.restore_id,
  status: row.status,
  backupTakenAt: row.backup_taken_at,
  restoredAt: row.restored_at,
  acknowledgedAt: row.acknowledged_at,
  latestGrantVersion: row.latest_grant_version,
});

function rows(
  db: PosDatabase,
  enrollmentId: string,
  statuses: readonly Status[],
): Row[] {
  return db
    .prepare(
      `SELECT * FROM store_restore WHERE enrollment_id = ? AND status IN (${statuses.map(() => "?").join(", ")})
       ORDER BY restored_at`,
    )
    .all(enrollmentId, ...statuses) as Row[];
}

/** Restores the back office has not acknowledged yet, oldest first. */
export function restoresAwaitingAcknowledgement(
  db: PosDatabase,
  enrollmentId: string,
): LocalStoreRestore[] {
  return rows(db, enrollmentId, ["reporting", "awaiting_acknowledgement"]).map(
    toLocal,
  );
}

/**
 * Whether a restore still stops offline selling here: not yet acknowledged, or acknowledged but no
 * pair issued since has been installed. No outage starts or continues meanwhile.
 */
export function storeRestoreBlocksOffline(
  db: PosDatabase,
  enrollmentId: string,
): boolean {
  return (
    rows(db, enrollmentId, [
      "reporting",
      "awaiting_acknowledgement",
      "acknowledged",
    ]).length > 0
  );
}

/** The highest version the server said it had issued, across this enrollment's restores (0 if none). */
export function restoredGrantFloor(
  db: PosDatabase,
  enrollmentId: string,
): number {
  const row = db
    .prepare(
      "SELECT max(latest_grant_version) AS v FROM store_restore WHERE enrollment_id = ?",
    )
    .get(enrollmentId) as { v: number | null };
  return row.v ?? 0;
}

/** Run in the transaction that installs a fresh pair: acknowledged restores are now behind it. */
export function clearAcknowledgedRestores(
  db: PosDatabase,
  enrollmentId: string,
  at: string,
): void {
  db.prepare(
    "UPDATE store_restore SET status = 'cleared', cleared_at = ?, updated_at = ? WHERE enrollment_id = ? AND status = 'acknowledged'",
  ).run(at, at, enrollmentId);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const backupTime = (at: number) => {
  const d = new Date(at);
  return `on ${d.getDate()} ${MONTHS[d.getMonth()]} at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Plain words for the counter while a restore waits. */
export function explainStoreRestore(
  restore: LocalStoreRestore,
  timeOf: (at: number) => string = backupTime,
): string {
  const taken = timeOf(restore.backupTakenAt);
  return restore.status === "reporting"
    ? `This computer was restored from a backup taken ${taken}. Offline selling stays off until the server has been told and a manager has checked it.`
    : `This computer was restored from a backup taken ${taken}. Offline selling stays off until the owner or a delegated manager acknowledges the restore in Settings → Offline policy, after checking receipts, cash and stock since then.`;
}

function isCounterRestore(
  value: unknown,
  restoreId: string,
): value is CounterStoreRestore {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.restoreId === restoreId &&
    (v.status === "awaiting_acknowledgement" || v.status === "acknowledged") &&
    Number.isSafeInteger(v.latestGrantVersion) &&
    (v.latestGrantVersion as number) >= 0 &&
    (v.status === "acknowledged") === (typeof v.acknowledgedAt === "number")
  );
}

export function createStoreRestoreSync(deps: {
  db: PosDatabase;
  api: Pick<ApiSession, "request">;
  terminal: Pick<TerminalService, "current">;
  report: (error: unknown) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let nextAttemptAt = 0;
  let failures = 0;

  function record(row: Row, answer: CounterStoreRestore): boolean {
    const at = new Date(now()).toISOString();
    const acknowledged = answer.status === "acknowledged";
    deps.db
      .prepare(
        `UPDATE store_restore SET status = ?, latest_grant_version = ?, acknowledged_at = ?, updated_at = ?
         WHERE restore_id = ? AND status IN ('reporting', 'awaiting_acknowledgement')`,
      )
      .run(
        answer.status,
        Math.max(answer.latestGrantVersion, row.latest_grant_version ?? 0),
        acknowledged ? new Date(answer.acknowledgedAt!).toISOString() : null,
        at,
        row.restore_id,
      );
    return acknowledged;
  }

  async function send(row: Row, branchId: string): Promise<boolean> {
    const envelope = JSON.parse(
      row.report_envelope,
    ) as Signed<OfflineCounterRestoreReport>;
    let answer: unknown;
    if (row.status === "awaiting_acknowledgement") {
      answer = await deps.api.request("POST", STATUS_PATH, {
        branchId,
        body: {
          identity: envelope.payload.identity,
          restoreId: row.restore_id,
        },
      });
      // The server has no record of it (or lost it): report again, unchanged. Its `null` arrives
      // as an empty body, which the API client reads as `undefined`.
      if (answer == null)
        answer = await deps.api.request("POST", REPORT_PATH, {
          branchId,
          body: { report: envelope },
        });
    } else {
      answer = await deps.api.request("POST", REPORT_PATH, {
        branchId,
        body: { report: envelope },
      });
    }
    if (!isCounterRestore(answer, row.restore_id))
      throw new Error("Unexpected store restore reply");
    return record(row, answer);
  }

  return {
    /** One pass. `acknowledged` when a restore was acknowledged just now: ask for a fresh pair. */
    async tick(): Promise<"acknowledged" | "waiting" | "none"> {
      const current = deps.terminal.current();
      if (!current) return "none";
      const pending = rows(deps.db, current.identity.enrollmentId, [
        "reporting",
        "awaiting_acknowledgement",
      ]);
      if (pending.length === 0) return "none";
      if (now() < nextAttemptAt) return "waiting";
      let acknowledged = false;
      try {
        for (const row of pending)
          if (await send(row, current.identity.branchId)) acknowledged = true;
        failures = 0;
        nextAttemptAt = now() + RESTORE_POLL_MS;
      } catch (error) {
        failures += 1;
        nextAttemptAt =
          now() +
          Math.min(BACKOFF_CAP_MS, FIRST_BACKOFF_MS * 2 ** (failures - 1));
        if (!(error instanceof ApiError && error.status === 0))
          deps.report(error);
      }
      const left = rows(deps.db, current.identity.enrollmentId, [
        "reporting",
        "awaiting_acknowledgement",
      ]).length;
      return acknowledged ? "acknowledged" : left ? "waiting" : "none";
    },
  };
}

export type StoreRestoreSync = ReturnType<typeof createStoreRestoreSync>;
