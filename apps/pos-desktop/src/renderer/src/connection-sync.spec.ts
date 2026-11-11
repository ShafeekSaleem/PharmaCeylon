import { describe, expect, it } from "@jest/globals";
import type { JournalSync } from "../../shared/ipc-contract";
import { timeWithSeconds } from "./format";
import {
  formatSyncedAgo,
  lastSyncLabels,
  offlineBackupReadyUntil,
  showLastSyncPill,
} from "./connection-sync";

const now = new Date("2026-11-09T14:32:16.000Z");
const lastAt = "2026-11-09T14:32:08.000Z";
const reachable = { reachable: true, checkedAt: "2026-11-09T14:00:00.000Z", latencyMs: 12 };

const journal: JournalSync = {
  recorded: 0,
  accepted: 0,
  waiting: 0,
  refused: 0,
  syncing: false,
  lastSuccessAt: lastAt,
  issue: null,
  pause: null,
  lastDrainAt: null,
};

describe("showLastSyncPill", () => {
  it("shows the mockup sync pill only for active, reachable counters with a confirmed sync", () => {
    expect(showLastSyncPill("active", reachable, journal)).toBe(true);
    expect(showLastSyncPill("active", reachable, { ...journal, syncing: true })).toBe(false);
    expect(showLastSyncPill("active", reachable, { ...journal, lastSuccessAt: null })).toBe(false);
    expect(showLastSyncPill("active", { ...reachable, reachable: false }, journal)).toBe(false);
    expect(showLastSyncPill("revoked", reachable, journal)).toBe(false);
    expect(showLastSyncPill("pending", reachable, journal)).toBe(false);
  });
});

describe("lastSyncLabels", () => {
  it("formats relative and clock copy from journal.lastSuccessAt, not api.checkedAt", () => {
    const labels = lastSyncLabels(lastAt, now);
    expect(labels.detailAgo).toBe("synced 8 s ago");
    expect(labels.detailClock).toBe(`last sync ${timeWithSeconds(new Date(lastAt))}`);
    expect(labels.detailClock).not.toContain("checked");
  });
});

describe("offlineBackupReadyUntil", () => {
  const backup = (usable: boolean, grantExpiresAt: string) => ({
    grantExpiresAt,
    snapshotGeneratedAt: "2026-11-09T14:00:00.000Z",
    authorizedStaff: 4,
    usable,
    failures: 0,
    failure: null,
  });

  it("shows ready until 22:00 while the grant is usable and not yet expired", () => {
    const grant = new Date(2026, 10, 9, 22, 0, 0).toISOString();
    const now = new Date(2026, 10, 9, 21, 0, 0);
    expect(offlineBackupReadyUntil(backup(true, grant), now)).toBe("ready until 22:00");
  });

  it("hides after the grant expiry without waiting for a readiness re-read", () => {
    const grant = new Date(2026, 10, 9, 22, 0, 0).toISOString();
    const now = new Date(2026, 10, 9, 22, 0, 1);
    expect(offlineBackupReadyUntil(backup(true, grant), now)).toBeNull();
  });

  it("hides when readiness marks the backup not usable even with a future grant", () => {
    const grant = new Date(2026, 10, 9, 22, 0, 0).toISOString();
    const now = new Date(2026, 10, 9, 21, 0, 0);
    expect(offlineBackupReadyUntil(backup(false, grant), now)).toBeNull();
  });

  it("is omitted when there is no backup", () => {
    expect(offlineBackupReadyUntil(null)).toBeNull();
  });
});

describe("formatSyncedAgo", () => {
  const from = (iso: string) => new Date(iso);

  it("uses seconds under a minute", () => {
    expect(formatSyncedAgo(from("2026-11-09T14:32:08.000Z"), now)).toBe("8 s ago");
  });

  it("uses minutes under an hour", () => {
    expect(formatSyncedAgo(from("2026-11-09T14:00:16.000Z"), now)).toBe("32 min ago");
  });

  it("uses hours under forty-eight hours", () => {
    expect(formatSyncedAgo(from("2026-11-09T08:32:16.000Z"), now)).toBe("6 h ago");
  });

  it("uses days beyond forty-eight hours", () => {
    expect(formatSyncedAgo(from("2026-11-07T14:32:16.000Z"), now)).toBe("2 days ago");
    expect(formatSyncedAgo(from("2026-11-06T14:32:16.000Z"), now)).toBe("3 days ago");
  });
});
