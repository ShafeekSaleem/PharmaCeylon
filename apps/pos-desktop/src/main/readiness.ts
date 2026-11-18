import { MAX_SNAPSHOT_AGE_AT_OUTAGE_MS } from "@pharmaceylon/shared";
import { drainHoldSentences } from "../shared/drain-holds";
import type { OfflineBackup, ReadinessCheck, ReadinessReport } from "../shared/ipc-contract";
import type { StoreBackupStatus } from "./backup/store-backup";
import type { OfflineAuthorityRefreshStatus } from "./terminal/offline-authority-refresh";
import type { JournalSyncView } from "./terminal/offline-journal-sync";
import type { TrustedNow } from "./terminal/trusted-clock";

export type ReadinessFacts = {
  databaseOpen: boolean;
  schemaVersion: number;
  latestSchemaVersion: number;
  credentialStoreAvailable: boolean;
  /** This counter's enrollment as last confirmed with the server; null when not enrolled. */
  enrollmentStatus?: "pending" | "active" | "revoked" | "retired" | null;
  /** People with a server-confirmed PIN verifier on this counter. */
  preparedStaff?: number;
  /** Sales and signed actions sent without a confirmed outcome. */
  unconfirmed?: number;
  /** Who started each unconfirmed sale. Anyone signed in here can confirm one. */
  unconfirmedSalesBy?: string[];
  /** Who sent each unconfirmed signed action: only they can confirm it. */
  unconfirmedBy?: string[];
  /** Offline authority (P3 #49). Absent: not looked at (not enrolled). */
  offlineAuthority?: {
    /** Null when this computer has no pinned server key, so it never asks for authority. */
    refresh: OfflineAuthorityRefreshStatus | null;
    installed: {
      grantExpiresAt: number;
      snapshotGeneratedAt: number;
      authorizedStaff: number;
      lines: number;
      /** The offline receipt series: the grant's prefix and the number the next offline sale gets. */
      receiptNumbering: { prefix: string; nextReceipt: string };
    } | null;
  };
  /** Display names of the printers installed in Windows. Absent: not looked at (no window yet). */
  printers?: string[];
  /** Trusted time for offline decisions (P4 #50). Absent: not looked at (no store open). */
  trustedClock?: TrustedNow;
  /** Offline card payments and support records (P4 #50). Absent: not looked at (not enrolled). */
  offlineRecords?: {
    /** Card attempts whose money is not settled, approved-but-unlinked ones included. */
    unresolvedCards: number;
    /** Of those, approved on the card machine with no sale linked yet. */
    approvedUnlinkedCards: number;
    /** Support records the server does not hold yet, refused ones included. */
    undelivered: number;
    /** Support records the server refused for good. */
    refused: number;
  };
  /** Backups of this computer's store (P5 #51, #166). Absent: not running (no store open). */
  storeBackups?: StoreBackupStatus;
  /** The offline journal's upload (P5 #51). Absent: not looked at (not enrolled). */
  journalSync?: {
    /** False when this computer has no pinned server key, so nothing can be verified. */
    configured: boolean;
    view: JournalSyncView;
  };
};

type Row = Pick<ReadinessCheck, "status" | "detail">;

const NEEDS_ACTIVATION = "Available once this device is activated.";

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:32 today", "14:32 tomorrow", otherwise "4 Nov 14:32" — the counter's local time. */
export function clockTime(at: number, now: Date): string {
  const when = new Date(at);
  const hm = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(when) - day(now)) / 86_400_000);
  if (days === 0) return `${hm} today`;
  if (days === 1) return `${hm} tomorrow`;
  if (days === -1) return `${hm} yesterday`;
  return `${when.getDate()} ${MONTHS[when.getMonth()]} ${hm}`;
}

/** What the last failed renewal needs, in words a person at the counter can act on. */
export function explainRefreshFailure(code: string): string {
  switch (code) {
    case "GRANT_INVALID":
      return "The server refused it. Check that offline selling is on for this branch in the back office, and that a cashier has prepared their PIN here.";
    case "BRANCH_HOURS_NOT_CONFIGURED":
      return "The branch's selling hours are not set. A manager sets them in the back office.";
    case "RECONCILIATION_REQUIRED":
      return "An offline sale from this counter was refused by the server, or a restored copy of this counter is waiting for a decision. A manager reviews it in the back office first.";
    case "RESTORED_COUNTER_WAIT":
      return "This counter was restored from an older copy. It can sell offline again once the offline permission issued before the restore runs out (at most a day); online selling works meanwhile.";
    case "local_usage":
      return "Offline sales recorded on this computer must be synchronised first. That happens by itself while someone is signed in.";
    case "journal_mismatch":
      return "The server holds offline records from this counter that this computer doesn't. Contact support.";
    case "restore_unacknowledged":
      return "This computer was restored from a backup. The owner or a delegated manager acknowledges the restore in the back office first.";
    case "drain_incomplete":
      return "Confirm the unconfirmed sales and actions first; synchronisation then finishes by itself.";
    case "invalid":
      return "The server's reply did not match this computer's offline key. Contact support.";
    case "NETWORK":
    case "TEMPORARILY_UNAVAILABLE":
      return "The server could not be reached. It retries by itself.";
    default:
      return /^HTTP_5/.test(code)
        ? "The server could not be reached. It retries by itself."
        : `The server refused it (${code}). It retries by itself; contact support if this stays.`;
  }
}

/** The grant and saved-stock rows, and the This counter summary. */
function offlineRows(facts: ReadinessFacts, now: Date): { grant: Row; catalogue: Row; backup: OfflineBackup | null } {
  const authority = facts.offlineAuthority;
  if (facts.enrollmentStatus !== "active" || !authority)
    return { grant: { status: "not_ready", detail: NEEDS_ACTIVATION }, catalogue: { status: "not_ready", detail: NEEDS_ACTIVATION }, backup: null };
  const { refresh, installed } = authority;
  if (!refresh) {
    const detail = "This computer has no offline permission key set up. Contact support.";
    return { grant: { status: "not_ready", detail }, catalogue: { status: "not_ready", detail }, backup: null };
  }
  const t = now.getTime();
  const failure = refresh.lastFailure ? explainRefreshFailure(refresh.lastFailure.code) : null;
  const retry = refresh.nextAttemptAt && refresh.nextAttemptAt > t
    ? ` Next try ${clockTime(refresh.nextAttemptAt, now).replace(/ today$/, "")}.` : "";
  const failing = failure ? ` Renewal failed: ${failure}${retry}` : "";

  if (!installed) {
    const detail = refresh.nominated === false
      ? "This counter is not the branch's offline backup. The owner chooses one in the back office."
      : failure
        ? `Not received yet. ${failure}${retry}`
        : "Not received yet. It is fetched automatically while someone is signed in here and online.";
    const status = failure ? "failed" : "not_ready";
    return { grant: { status, detail }, catalogue: { status, detail: "Saved automatically with the offline permission." }, backup: null };
  }

  const expired = t >= installed.grantExpiresAt;
  const age = t - installed.snapshotGeneratedAt;
  const usable = !expired && age <= MAX_SNAPSHOT_AGE_AT_OUTAGE_MS;
  const replaced = refresh.nominated === false;
  const renewHint = "Sign in here while online to renew it.";
  const grant: Row = replaced
    ? { status: "failed", detail: `This counter is no longer the branch's offline backup. Its permission is not renewed${expired ? "" : ` and ends ${clockTime(installed.grantExpiresAt, now)}`}.` }
    : expired
      ? { status: "failed", detail: `Expired ${clockTime(installed.grantExpiresAt, now)}.${failing || ` ${renewHint}`}` }
      : failure
        ? { status: "warning", detail: `Valid until ${clockTime(installed.grantExpiresAt, now)}.${failing}` }
        : { status: "ok", detail: `Valid until ${clockTime(installed.grantExpiresAt, now)}. Renewed automatically while online.` };
  const minutes = Math.floor(age / 60_000);
  const saved = `Stock and prices saved ${clockTime(installed.snapshotGeneratedAt, now)}, ${installed.lines} ${installed.lines === 1 ? "batch" : "batches"}.`;
  const catalogue: Row = age <= MAX_SNAPSHOT_AGE_AT_OUTAGE_MS
    ? { status: failure ? "warning" : "ok", detail: failure ? `${saved}${failing}` : saved }
    : {
        status: "failed",
        detail: `Saved stock is ${minutes} minutes old, over the ${MAX_SNAPSHOT_AGE_AT_OUTAGE_MS / 60_000}-minute limit for starting an outage.${failing || (replaced ? "" : ` ${renewHint}`)}`,
      };
  return {
    grant,
    catalogue,
    backup: {
      grantExpiresAt: new Date(installed.grantExpiresAt).toISOString(),
      snapshotGeneratedAt: new Date(installed.snapshotGeneratedAt).toISOString(),
      authorizedStaff: installed.authorizedStaff,
      usable: usable && !replaced,
      failures: refresh.consecutiveFailures,
      failure,
    },
  };
}

/** The Synchronisation row: the offline journal's upload and the reconnect drain (P5 #51). */
function syncRow(facts: ReadinessFacts, now: Date): Row {
  const sync = facts.journalSync;
  if (facts.enrollmentStatus !== "active" || !sync) return { status: "not_ready", detail: NEEDS_ACTIVATION };
  if (!sync.configured)
    return { status: "not_ready", detail: "This computer has no offline permission key set up. Contact support." };
  const { view } = sync;
  const at = (iso: string) => clockTime(Date.parse(iso), now);
  const waiting = `${view.waiting} offline ${view.waiting === 1 ? "record" : "records"} waiting to reach the server.`;
  if (view.refused > 0 || view.issue?.code === "JOURNAL_MISMATCH" || view.issue?.code === "STORE_RESTORED")
    return { status: "failed", detail: `${view.issue?.message ?? "An offline record was refused."}${view.waiting ? ` ${waiting}` : ""}` };
  if (view.pause) {
    const { sales, actions } = view.pause.unconfirmed;
    const unconfirmed = [
      sales ? `${sales} ${sales === 1 ? "sale" : "sales"}` : null,
      actions ? `${actions} ${actions === 1 ? "action" : "actions"}` : null,
    ].filter((part): part is string => part !== null);
    const holds = drainHoldSentences(view.pause.holds);
    const confirming = unconfirmed.length
      ? ` It finishes once ${unconfirmed.join(" and ")} sent from here ${sales + actions === 1 ? "is" : "are"} confirmed.`
      : "";
    return {
      status: "warning",
      detail: `Synchronising offline sales: new sales wait until it finishes. ${
        view.waiting ? waiting : unconfirmed.length || holds.length ? "The offline sales are on the server." : "Waiting for fresh stock from the server."
      }${confirming}${holds.map((sentence) => ` ${sentence}`).join("")}${view.issue ? ` ${view.issue.message}` : ""}`,
    };
  }
  if (view.issue) return { status: "warning", detail: view.issue.message };
  if (!view.lastSuccessAt) return { status: "not_ready", detail: "Not confirmed with the server yet. It checks by itself while someone is signed in." };
  const drained = view.lastDrain ? ` Offline sales from the outage at ${clockTime(view.lastDrain.startedAt, now)} are all on the server.` : "";
  return {
    status: "ok",
    detail: `Everything recorded here is on the server, confirmed ${at(view.lastSuccessAt)}.${drained}`,
  };
}

/** The offline receipt series, from the installed offline permission. */
function receiptRow(facts: ReadinessFacts, now: Date): Row {
  const authority = facts.offlineAuthority;
  if (facts.enrollmentStatus !== "active" || !authority) return { status: "not_ready", detail: NEEDS_ACTIVATION };
  if (!authority.refresh)
    return { status: "not_ready", detail: "This computer has no offline permission key set up. Contact support." };
  const installed = authority.installed;
  if (!installed)
    return { status: "not_ready", detail: "Comes with the offline permission, which has not been received yet." };
  const { prefix, nextReceipt } = installed.receiptNumbering;
  if (now.getTime() >= installed.grantExpiresAt)
    return {
      status: "failed",
      detail: `The offline permission that holds the receipt series ${prefix} has expired. A renewed one brings it back.`,
    };
  return { status: "ok", detail: `Offline receipts use the series ${prefix}. The next one is ${nextReceipt}.` };
}

/** The receipt printer: what Windows has installed. The printer itself is chosen at each sale. */
function printerRow(facts: ReadinessFacts): Row {
  const printers = facts.printers;
  if (!printers) return { status: "not_ready", detail: "Not checked yet: the counter is still starting." };
  if (printers.length === 0)
    return { status: "not_ready", detail: "No printer is installed in Windows on this computer, so receipts can't print." };
  const installed = printers.length === 1 ? `${printers[0]} is` : `${printers.length} printers are (${printers.join(", ")})`;
  return { status: "ok", detail: `${installed} installed in Windows. Print a test receipt below to check it.` };
}

/** Trusted time (P4 #50): offline selling needs the server's signed time, carried on by Windows uptime. */
function clockRow(facts: ReadinessFacts, now: Date): Row {
  const clock = facts.trustedClock;
  if (facts.enrollmentStatus !== "active" || !clock) return { status: "not_ready", detail: NEEDS_ACTIVATION };
  if (clock.trusted)
    return {
      status: "ok",
      detail: `Set from the server's time, last received ${clockTime(clock.anchoredAt, now)}. The Windows clock is not used.`,
    };
  if (clock.reason === "NO_ANCHOR")
    return {
      status: "not_ready",
      detail: "The server's time has not been received yet. It arrives by itself while someone is signed in here and online.",
    };
  return {
    status: "failed",
    detail:
      "Windows restarted since the server's time was last received, so offline selling is stopped until this counter is online again. It sets itself once online.",
  };
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Card payments taken during an outage whose money is not settled (P4 #50). */
function cardsRow(facts: ReadinessFacts): Row {
  const records = facts.offlineRecords;
  if (facts.enrollmentStatus !== "active" || !records) return { status: "not_ready", detail: NEEDS_ACTIVATION };
  const { unresolvedCards: unresolved, approvedUnlinkedCards: approved } = records;
  if (unresolved === 0) return { status: "ok", detail: "Every card payment from an offline sale is settled." };
  const unknown = unresolved - approved;
  const how = [
    approved ? `${approved} approved with no sale linked` : null,
    unknown ? `${unknown} with no card machine result recorded` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return {
    status: "warning",
    detail: `${counted(unresolved, "card payment is", "card payments are")} not settled: ${how}. After an outage, online selling waits until they are. Record what the card machine did under Offline records below.`,
  };
}

/** Offline notes and card records still to reach the server (P4 #50). */
function supportRow(facts: ReadinessFacts): Row {
  const records = facts.offlineRecords;
  if (facts.enrollmentStatus !== "active" || !records) return { status: "not_ready", detail: NEEDS_ACTIVATION };
  const { undelivered, refused } = records;
  const waiting = undelivered - refused;
  const waitingText = waiting
    ? `${counted(waiting, "note or card record is", "notes or card records are")} waiting to upload. They upload by themselves while someone is signed in and online.`
    : "";
  if (refused > 0)
    return {
      status: "failed",
      detail: `The server turned down ${counted(refused, "note or card record", "notes or card records")}. ${
        refused === 1 ? "It will not clear by itself" : "They will not clear by themselves"
      }: contact support.${waitingText ? ` ${waitingText}` : ""}`,
    };
  if (waiting > 0) return { status: "warning", detail: waitingText };
  return { status: "ok", detail: "Every offline note and card record is on the server." };
}

const DEVICE_CHECK: Record<"none" | "pending" | "active" | "revoked" | "retired", Pick<ReadinessCheck, "status" | "detail">> = {
  none: { status: "not_ready", detail: "This device has not been enrolled at a branch." },
  pending: { status: "warning", detail: "Enrollment did not finish. A manager must sign in here." },
  active: { status: "ok", detail: "Enrolled as a counter." },
  revoked: { status: "failed", detail: "This counter was switched off in the back office." },
  retired: { status: "failed", detail: "This computer was retired in the back office." },
};


/**
 * The FR-004 checklist. Checks that depend on device activation report
 * `not_ready` until that exists, so the terminal can never claim to be ready
 * for an outage on the strength of the parts that happen to be built.
 */
/** Backups fail quietly otherwise: a counter that cannot back up must not look like one that can. */
export const BACKUP_FAILURES_SHOWN = 2;

function backupRow(facts: ReadinessFacts, now: Date): Row | null {
  const backups = facts.storeBackups;
  // Only a counter is backed up; before enrollment there is nothing to say.
  if (!backups || !facts.enrollmentStatus) return null;
  const last =
    backups.lastBackupAt === null ? "There is no backup on this computer." : `Last backup ${clockTime(backups.lastBackupAt, now)}.`;
  if (backups.failures >= BACKUP_FAILURES_SHOWN)
    return {
      status: "warning",
      detail: `The last ${backups.failures} backups failed (since ${clockTime(backups.failingSince ?? now.getTime(), now)}). ${last} Contact support: the app log says why.`,
    };
  if (backups.lastBackupAt === null) return { status: "ok", detail: "The first backup is being taken." };
  return { status: "ok", detail: `${last} Backups stay on this computer.` };
}

export function buildReadinessReport(facts: ReadinessFacts, now: Date): ReadinessReport {
  const offline = offlineRows(facts, now);
  const offlineStaff = offline.backup ? offline.backup.authorizedStaff : null;
  const schemaCurrent = facts.databaseOpen && facts.schemaVersion === facts.latestSchemaVersion;

  const checks: ReadinessCheck[] = [
    {
      id: "database",
      label: "Local database",
      status: facts.databaseOpen ? "ok" : "failed",
      detail: facts.databaseOpen ? "Encrypted database is open." : "The local database could not be opened.",
    },
    {
      id: "schema",
      label: "Database version",
      status: schemaCurrent ? "ok" : "failed",
      detail: schemaCurrent ? `Schema version ${facts.schemaVersion}.` : "The local database is not up to date.",
    },
    {
      id: "credential-store",
      label: "Windows credential protection",
      status: facts.credentialStoreAvailable ? "ok" : "failed",
      detail: facts.credentialStoreAvailable
        ? "Database key is protected by Windows."
        : "Windows credential protection is not available.",
    },
    { id: "device", label: "Device enrollment", ...DEVICE_CHECK[facts.enrollmentStatus ?? "none"] },
    {
      id: "staff",
      label: "Prepared staff",
      status: (facts.preparedStaff ?? 0) > 0 ? "ok" : "not_ready",
      detail:
        (facts.preparedStaff ?? 0) > 0
          ? `${facts.preparedStaff} ${facts.preparedStaff === 1 ? "person has" : "people have"} a PIN prepared here.${
              offlineStaff === null ? "" : ` ${offlineStaff} can sign in offline under the current permission.`
            }`
          : "Nobody has prepared their PIN on this counter yet.",
    },
    {
      id: "unconfirmed",
      label: "Unconfirmed sales and actions",
      status: (facts.unconfirmed ?? 0) === 0 ? "ok" : "warning",
      detail:
        (facts.unconfirmed ?? 0) === 0
          ? "Every sale and action sent from here has a confirmed outcome."
          : `${facts.unconfirmed} waiting for confirmation with the server.${
              facts.unconfirmedSalesBy?.length
                ? ` Sales started by ${facts.unconfirmedSalesBy.join(", ")}: anyone signed in here can confirm them.`
                : ""
            }${
              facts.unconfirmedBy?.length
                ? ` Only the person who sent each action can confirm it: ${facts.unconfirmedBy.join(", ")}.`
                : ""
            }`,
    },
    { id: "grant", label: "Offline permission", ...offline.grant },
    { id: "catalogue", label: "Product catalogue", ...offline.catalogue },
    { id: "receipt-numbers", label: "Receipt numbering", ...receiptRow(facts, now) },
    { id: "clock", label: "Trusted time", ...clockRow(facts, now) },
    { id: "printer", label: "Receipt printer", ...printerRow(facts) },
    { id: "sync", label: "Synchronisation", ...syncRow(facts, now) },
    { id: "card-money", label: "Offline card payments", ...cardsRow(facts) },
    { id: "support-records", label: "Offline notes and card records", ...supportRow(facts) },
  ];
  const backups = backupRow(facts, now);
  if (backups) checks.splice(3, 0, { id: "backups", label: "Store backups", ...backups });

  return {
    ready: checks.every((check) => check.status === "ok"),
    checkedAt: now.toISOString(),
    checks,
    offlineBackup: offline.backup,
  };
}
