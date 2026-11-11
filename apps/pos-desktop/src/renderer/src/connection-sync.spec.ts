import { describe, expect, it } from "@jest/globals";
import type { JournalSync } from "../../shared/ipc-contract";
import { timeWithSeconds } from "./format";
import {
  SALES_ATTENTION_PILL,
  SYNC_STALE_MS,
  deriveSyncState,
  formatStatusSyncClock,
  formatSyncedAgo,
  offlineBackupReadyUntil,
} from "./connection-sync";

const now = new Date("2026-11-11T09:14:16.000Z");
const apiOk = { reachable: true, checkedAt: "2026-11-11T09:14:05.000Z", latencyMs: 5 };
const apiDown = { reachable: false, checkedAt: "2026-11-11T09:14:05.000Z", latencyMs: 0 };

const baseJournal = (over: Partial<JournalSync> = {}): JournalSync => ({
  recorded: 0,
  accepted: 0,
  waiting: 0,
  refused: 0,
  syncing: false,
  lastSuccessAt: "2026-11-11T09:14:08.000Z",
  issue: null,
  pause: null,
  lastDrainAt: null,
  lastStockDownloadAt: "2026-11-11T09:10:00.000Z",
  stockDownloadNominated: true,
  ...over,
});

describe("deriveSyncState — inactive / fallback", () => {
  it("returns null when not active", () => {
    expect(deriveSyncState("revoked", apiOk, baseJournal(), now, false)).toBeNull();
    expect(deriveSyncState("pending", apiOk, baseJournal(), now, false)).toBeNull();
  });
});

describe("deriveSyncState — states 0–6 (sales-only)", () => {
  const salesOnly = (over: Partial<JournalSync> = {}): JournalSync =>
    baseJournal({ stockDownloadNominated: null, lastStockDownloadAt: null, ...over });

  it("0 synced baseline", () => {
    const d = deriveSyncState("active", apiOk, salesOnly(), now, false)!;
    expect(d.caseId).toBe("T7");
    expect(d.tone).toBe("ok");
    expect(d.titleDetail).toBe("synced 8 s ago");
    expect(d.statusParts[0]?.text).toMatch(/Sales sent 09:14/);
  });

  it("attention: issue only — amber pill and status, not syncing", () => {
    const msg = "A manager reviews it in the back office.";
    const d = deriveSyncState(
      "active",
      apiOk,
      salesOnly({ issue: { code: "HELD", message: msg }, waiting: 2, syncing: true }),
      now,
      true,
    )!;
    expect(d.caseId).toBe("attention");
    expect(d.tone).toBe("warn");
    expect(d.titleDetail).toBe(SALES_ATTENTION_PILL);
    expect(d.statusParts[0]?.text).toBe(`⚠ Sales not sent · ${msg}`);
    expect(d.tooltip).toContain(msg);
    expect(d.tooltip).toContain("Sales sent:");
    expect(d.tone).not.toBe("info");
  });

  it("attention: refused only", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      salesOnly({ refused: 1, issue: { code: "HELD", message: "Held for review." } }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("attention");
    expect(d.titleDetail).toBe(SALES_ATTENTION_PILL);
    expect(d.statusParts[0]?.text).toContain("⚠ Sales not sent");
  });

  it("attention: journal mismatch only", () => {
    const msg = "This counter's journal does not match the server.";
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({
        issue: { code: "JOURNAL_MISMATCH", message: msg },
        stockDownloadNominated: true,
      }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("attention");
    expect(d.statusParts[0]?.text).toBe(`⚠ Sales not sent · ${msg}`);
    expect(d.statusParts[1]?.text).toMatch(/Stock updated/);
  });

  it("attention: sales-only counter (T7)", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      salesOnly({ issue: { code: "NETWORK", message: "Try again shortly." } }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("attention");
    expect(d.statusParts).toHaveLength(1);
    expect(d.statusParts[0]?.text).toContain("⚠ Sales not sent");
  });

  it("attention: beats syncing (no cyan state 2)", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({ syncing: true, waiting: 4, issue: { code: "HELD", message: "Blocked." } }),
      now,
      true,
    )!;
    expect(d.caseId).toBe("attention");
    expect(d.tone).toBe("warn");
    expect(d.statusParts[0]?.text).toContain("⚠ Sales not sent");
  });

  it("attention: offline with issue stays red (case 5)", () => {
    const d = deriveSyncState(
      "active",
      apiDown,
      salesOnly({
        lastSuccessAt: "2026-11-11T09:02:08.000Z",
        issue: { code: "HELD", message: "Still blocked." },
      }),
      now,
      false,
    )!;
    expect(d.tone).toBe("bad");
    expect(d.caseId).toBe("5");
    expect(d.statusParts[0]?.text).not.toContain("⚠ Sales not sent");
    expect(d.tooltip).toContain("Still blocked.");
  });

  it("pause uses a reason instead of synced ago", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      salesOnly({
        pause: { reason: "draining", waiting: 1, outageStartedAt: null, unconfirmed: { sales: 0, actions: 0 } },
      }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("0-blocked");
    expect(d.titleDetail).toBe("Synchronising offline sales");
  });

  it("1 checking the server", () => {
    const d = deriveSyncState("active", null, salesOnly(), now, false)!;
    expect(d.caseId).toBe("1");
    expect(d.tone).toBe("wait");
    expect(d.pulse).toBe(true);
    expect(d.titleLead).toBe("Checking the server…");
  });

  it("2 syncing with journal.syncing latched", () => {
    const d = deriveSyncState("active", apiOk, salesOnly({ syncing: true }), now, true)!;
    expect(d.caseId).toBe("2");
    expect(d.tone).toBe("info");
    expect(d.titleDetail).toBe("syncing…");
  });

  it("2 folds sales waiting (no separate T4)", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      salesOnly({ waiting: 3, lastSuccessAt: "2026-11-11T09:13:00.000Z" }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("2");
    expect(d.statusParts[0]?.text).toContain("syncing now");
  });

  it("3 online never synced", () => {
    const d = deriveSyncState("active", apiOk, salesOnly({ lastSuccessAt: null }), now, false)!;
    expect(d.caseId).toBe("3");
    expect(d.tone).toBe("warn");
  });

  it("4 offline never synced", () => {
    const d = deriveSyncState("active", apiDown, salesOnly({ lastSuccessAt: null }), now, false)!;
    expect(d.caseId).toBe("4");
    expect(d.tone).toBe("bad");
  });

  it("5 offline last sync known", () => {
    const d = deriveSyncState(
      "active",
      apiDown,
      salesOnly({ lastSuccessAt: "2026-11-11T09:02:08.000Z" }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("5");
    expect(d.statusParts[0]?.text).toBe("last sync 09:02:08");
  });

  it("6 sync overdue", () => {
    const old = new Date(now.getTime() - SYNC_STALE_MS - 60_000).toISOString();
    const d = deriveSyncState("active", apiOk, salesOnly({ lastSuccessAt: old }), now, false)!;
    expect(d.caseId).toBe("6");
    expect(d.tone).toBe("warn");
    expect(d.titleDetail).toMatch(/sync overdue/);
  });

  it("precedence: offline ignores syncing", () => {
    const d = deriveSyncState(
      "active",
      apiDown,
      salesOnly({ syncing: true, lastSuccessAt: "2026-11-11T09:02:08.000Z" }),
      now,
      true,
    )!;
    expect(d.caseId).toBe("5");
  });

  it("precedence: issue beats syncing (visible timestamps, mismatch in tooltip)", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      salesOnly({
        issue: { code: "JOURNAL_MISMATCH", message: "The journal on this counter does not match the server." },
        syncing: true,
        waiting: 4,
      }),
      now,
      true,
    )!;
    expect(d.attentionPending).toBe(true);
    expect(d.caseId).not.toBe("2");
    expect(d.tooltip).toContain("does not match the server");
  });

  it("precedence: syncing beats overdue", () => {
    const old = new Date(now.getTime() - SYNC_STALE_MS - 60_000).toISOString();
    const d = deriveSyncState("active", apiOk, salesOnly({ lastSuccessAt: old, syncing: true }), now, true)!;
    expect(d.caseId).toBe("2");
  });
});

describe("deriveSyncState — two-way T1–T6", () => {
  it("T1 both fresh", () => {
    const d = deriveSyncState("active", apiOk, baseJournal(), now, false)!;
    expect(d.caseId).toBe("T1");
    expect(d.tone).toBe("ok");
    expect(d.statusParts).toHaveLength(2);
  });

  it("T2 stock overdue", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({ lastStockDownloadAt: "2026-11-11T08:42:00.000Z" }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("T2");
    expect(d.titleDetail).toMatch(/stock overdue/);
    expect(d.statusParts[1]?.tone).toBe("warn");
  });

  it("T3 stock never", () => {
    const d = deriveSyncState("active", apiOk, baseJournal({ lastStockDownloadAt: null }), now, false)!;
    expect(d.caseId).toBe("T3");
    expect(d.titleDetail).toBe("stock not updated yet");
  });

  it("T4 sales overdue", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({ lastSuccessAt: "2026-11-11T07:00:00.000Z" }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("T4");
    expect(d.titleDetail).toMatch(/sales overdue/);
  });

  it("T5 both overdue", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({
        lastSuccessAt: "2026-11-11T07:00:00.000Z",
        lastStockDownloadAt: "2026-11-11T06:58:00.000Z",
      }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("T5");
    expect(d.titleDetail).toMatch(/sync overdue/);
  });

  it("T6 offline both known", () => {
    const d = deriveSyncState("active", apiDown, baseJournal(), now, false)!;
    expect(d.caseId).toBe("T6");
    expect(d.tone).toBe("bad");
    expect(d.statusParts.every((p) => p.tone === "muted")).toBe(true);
  });

  it("T7 nominated false uses sales-only and stock never does not warn", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({ stockDownloadNominated: false, lastStockDownloadAt: null }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("T7");
    expect(d.tone).toBe("ok");
    expect(d.statusParts).toHaveLength(1);
    expect(d.statusParts[0]?.text).toMatch(/Sales sent/);
  });

  it("null nominated is sales-only (no stock amber flash)", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({ stockDownloadNominated: null, lastStockDownloadAt: null }),
      now,
      false,
    )!;
    expect(d.caseId).toBe("T7");
    expect(d.tone).toBe("ok");
  });

  it("two-way attention includes stock line in tooltip", () => {
    const d = deriveSyncState(
      "active",
      apiOk,
      baseJournal({
        issue: { code: "HELD", message: "Held for review." },
        waiting: 1,
        syncing: true,
      }),
      now,
      true,
    )!;
    expect(d.tooltip).toContain("Held for review.");
    expect(d.tooltip).toContain("Stock updated:");
    expect(d.attentionPending).toBe(true);
    expect(d.tone).not.toBe("info");
  });
});

describe("formatStatusSyncClock", () => {
  it("shows exact last sync 14:32:08 under Jest UTC", () => {
    const at = "2026-11-09T14:32:08.000Z";
    expect(formatStatusSyncClock(at, new Date("2026-11-09T15:00:00.000Z"))).toBe(
      timeWithSeconds(new Date(at)),
    );
    expect(`last sync ${formatStatusSyncClock(at, new Date("2026-11-09T15:00:00.000Z"))}`).toBe(
      "last sync 14:32:08",
    );
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
  const tick = new Date("2026-11-09T14:32:16.000Z");
  const from = (iso: string) => new Date(iso);

  it("uses seconds under a minute", () => {
    expect(formatSyncedAgo(from("2026-11-09T14:32:08.000Z"), tick)).toBe("8 s ago");
  });

  it("uses minutes under an hour", () => {
    expect(formatSyncedAgo(from("2026-11-09T14:00:16.000Z"), tick)).toBe("32 min ago");
  });

  it("uses hours under forty-eight hours", () => {
    expect(formatSyncedAgo(from("2026-11-09T08:32:16.000Z"), tick)).toBe("6 h ago");
  });

  it("uses days beyond forty-eight hours", () => {
    expect(formatSyncedAgo(from("2026-11-07T14:32:16.000Z"), tick)).toBe("2 days ago");
    expect(formatSyncedAgo(from("2026-11-06T14:32:16.000Z"), tick)).toBe("3 days ago");
  });
});
