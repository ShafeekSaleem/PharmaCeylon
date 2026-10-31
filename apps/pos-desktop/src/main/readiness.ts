import type { ReadinessCheck, ReadinessReport } from "../shared/ipc-contract";

export type ReadinessFacts = {
  databaseOpen: boolean;
  schemaVersion: number;
  latestSchemaVersion: number;
  credentialStoreAvailable: boolean;
  /** This counter's enrollment as last confirmed with the server; null when not enrolled. */
  enrollmentStatus?: "pending" | "active" | "revoked" | "retired" | null;
};

const DEVICE_CHECK: Record<"none" | "pending" | "active" | "revoked" | "retired", Pick<ReadinessCheck, "status" | "detail">> = {
  none: { status: "not_ready", detail: "This device has not been enrolled at a branch." },
  pending: { status: "warning", detail: "Enrollment did not finish. A manager must sign in here." },
  active: { status: "ok", detail: "Enrolled as a counter." },
  revoked: { status: "failed", detail: "This counter was switched off in the back office." },
  retired: { status: "failed", detail: "This computer was retired in the back office." },
};

const NEEDS_ACTIVATION = "Available once this device is activated.";

/**
 * The FR-004 checklist. Checks that depend on device activation report
 * `not_ready` until that exists, so the terminal can never claim to be ready
 * for an outage on the strength of the parts that happen to be built.
 */
export function buildReadinessReport(facts: ReadinessFacts, now: Date): ReadinessReport {
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
    { id: "grant", label: "Offline permission", status: "not_ready", detail: NEEDS_ACTIVATION },
    { id: "catalogue", label: "Product catalogue", status: "not_ready", detail: NEEDS_ACTIVATION },
    { id: "receipt-numbers", label: "Receipt numbering", status: "not_ready", detail: NEEDS_ACTIVATION },
    { id: "printer", label: "Receipt printer", status: "not_ready", detail: "No receipt printer has been set up." },
    { id: "sync", label: "Synchronisation", status: "not_ready", detail: NEEDS_ACTIVATION },
  ];

  return {
    ready: checks.every((check) => check.status === "ok"),
    checkedAt: now.toISOString(),
    checks,
  };
}
