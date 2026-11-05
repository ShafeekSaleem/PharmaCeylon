import { MAX_SNAPSHOT_AGE_AT_OUTAGE_MS } from "@pharmaceylon/shared";
import type { OfflineBackup, ReadinessCheck, ReadinessReport } from "../shared/ipc-contract";
import type { OfflineAuthorityRefreshStatus } from "./terminal/offline-authority-refresh";

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
    } | null;
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
    case "reconciliation_required":
      return "Offline sales from this counter must be reconciled online first.";
    case "local_usage":
      return "Offline sales recorded on this computer must be synchronised first.";
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
    { id: "receipt-numbers", label: "Receipt numbering", status: "not_ready", detail: NEEDS_ACTIVATION },
    { id: "printer", label: "Receipt printer", status: "not_ready", detail: "No receipt printer has been set up." },
    { id: "sync", label: "Synchronisation", status: "not_ready", detail: NEEDS_ACTIVATION },
  ];

  return {
    ready: checks.every((check) => check.status === "ok"),
    checkedAt: now.toISOString(),
    checks,
    offlineBackup: offline.backup,
  };
}
