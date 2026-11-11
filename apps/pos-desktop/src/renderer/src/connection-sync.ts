import type { ApiReachability, JournalSync, OfflineBackup } from "../../shared/ipc-contract";
import { longDayColombo, shortDay, time, timeColomboWithSeconds, timeWithSeconds } from "./format";

/** Approved overdue threshold (Shafeek, 11 Nov 2026). */
export const SYNC_STALE_MS = 15 * 60 * 1000;

export type SyncTone = "ok" | "wait" | "info" | "warn" | "bad";

export type TextPart = { text: string; tone?: "default" | "warn" | "muted" };

export type DerivedSync = {
  /** Use last-sync UI (active enrolled counter) instead of reachability fallback. */
  active: boolean;
  tone: SyncTone;
  pulse: boolean;
  titleLead: string;
  titleDetail?: string;
  statusLead: string;
  statusParts: TextPart[];
  tooltip: string;
  ariaLabel: string;
  caseId: string;
  /** Online sales-attention state (refused / journal issue), approved 11 Nov 2026. */
  attentionPending?: boolean;
};

/** Approved pill detail (Shafeek, option A, 11 Nov 2026 3:39 PM Asia/Colombo). */
export const SALES_ATTENTION_PILL = "sales need attention";

export function formatSyncedAgo(from: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Status-bar clock for single-direction states: seconds today, short date otherwise. */
export function formatStatusSyncClock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (sameLocalDay(at, now)) return timeWithSeconds(at);
  return `${shortDay(at)} ${time(at)}`;
}

/** Two-way status bar HH:MM (no seconds). */
function formatDirectionClock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (sameLocalDay(at, now)) return time(at);
  return `${shortDay(at)} ${time(at)}`;
}

function tooltipStamp(iso: string): string {
  const at = new Date(iso);
  return `${longDayColombo(at)}, ${timeColomboWithSeconds(at)}`;
}

function serverChecked(api: ApiReachability | null): string {
  if (!api?.checkedAt) return "";
  return `Server checked: ${timeColomboWithSeconds(new Date(api.checkedAt))} · Sri Lanka time`;
}

export function syncNeedsAttention(journal: JournalSync): boolean {
  return journal.refused > 0 || journal.issue !== null;
}

/** Reason text already on `JournalSync` from main (issue.message, or recovery copy for mismatch). */
export function journalAttentionReason(journal: JournalSync): string {
  return journal.issue?.message?.trim() ?? "";
}

function stockStatusParts(
  stockAt: string | null,
  stock: DirState | null,
  now: Date,
): TextPart[] {
  if (!stock) return [];
  if (stock === "never") return [{ text: "⚠ Stock not updated yet", tone: "warn" }];
  if (!stockAt) return [];
  if (stock === "overdue") {
    return [{ text: `⚠ Stock updated ${formatDirectionClock(stockAt, now)}, overdue`, tone: "warn" }];
  }
  return [{ text: `Stock updated ${formatDirectionClock(stockAt, now)}` }];
}

function deriveOnlineAttentionState(
  journal: JournalSync,
  twoWay: boolean,
  salesAt: string | null,
  stockAt: string | null,
  stock: DirState | null,
  api: ApiReachability | null,
  now: Date,
): DerivedSync {
  const reason = journalAttentionReason(journal);
  const salesStatus = reason
    ? `⚠ Sales not sent · ${reason}`
    : "⚠ Sales not sent";
  const statusParts: TextPart[] = [{ text: salesStatus, tone: "warn" }, ...stockStatusParts(stockAt, stock, now)];
  const tipLines = [
    salesAt ? `Sales sent: ${tooltipStamp(salesAt)}` : "",
    twoWay && stockAt ? `Stock updated: ${tooltipStamp(stockAt)}` : "",
    twoWay && !stockAt ? "Stock updated: not yet on this counter" : "",
    reason,
  ];
  const tooltip = [...tipLines, serverChecked(api)].filter(Boolean).join(" · ");
  return {
    active: true,
    tone: "warn",
    pulse: false,
    titleLead: "Online",
    titleDetail: SALES_ATTENTION_PILL,
    statusLead: "Online",
    statusParts,
    tooltip,
    ariaLabel: "Online, sales need attention",
    caseId: "attention",
    attentionPending: true,
  };
}

function offlineTooltip(base: string, journal: JournalSync, api: ApiReachability | null): string {
  const lines = [base];
  const reason = journalAttentionReason(journal);
  if (syncNeedsAttention(journal) && reason) lines.push(reason);
  const checked = serverChecked(api);
  if (checked) lines.push(checked);
  return lines.filter(Boolean).join(" · ");
}

type DirState = "fresh" | "overdue" | "never";

function dirState(iso: string | null, now: Date): DirState {
  if (!iso) return "never";
  const age = now.getTime() - new Date(iso).getTime();
  if (age > SYNC_STALE_MS) return "overdue";
  return "fresh";
}

function olderIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}

function dirRank(s: DirState): number {
  if (s === "never") return 3;
  if (s === "overdue") return 2;
  return 1;
}

function worse(a: DirState, b: DirState): DirState {
  return dirRank(a) >= dirRank(b) ? a : b;
}

function canShowSynced(journal: JournalSync): boolean {
  return !journal.issue && !journal.pause;
}

/**
 * Pure last-sync state for the title pill and status-bar lead (states 0–6 and two-way T1–T7).
 * TODO(epic #103): when a combined upload+download sync time exists, pass it in place of lastSuccessAt alone.
 */
type EnrollmentStatus = "pending" | "active" | "revoked" | "retired" | undefined;

export function deriveSyncState(
  enrollmentStatus: EnrollmentStatus,
  api: ApiReachability | null,
  journal: JournalSync | null,
  now: Date,
  showJournalSyncing: boolean,
): DerivedSync | null {
  if (enrollmentStatus !== "active" || !journal) return null;
  return deriveSyncStateUi(enrollmentStatus, api, journal, now, showJournalSyncing);
}

function deriveSyncStateUi(
  enrollmentStatus: EnrollmentStatus,
  api: ApiReachability | null,
  journal: JournalSync,
  now: Date,
  showJournalSyncing: boolean,
): DerivedSync {

  const twoWay = journal.stockDownloadNominated === true;
  const salesAt = journal.lastSuccessAt;
  const stockAt = journal.lastStockDownloadAt;
  const sales = dirState(salesAt, now);
  const stock = twoWay ? dirState(stockAt, now) : null;

  const baseTooltip = (lines: string[]) =>
    [...lines, serverChecked(api)].filter(Boolean).join(" · ");

  // 1 — checking the server
  if (api === null) {
    const statusParts: TextPart[] = [];
    if (salesAt) {
      statusParts.push({ text: `last sync ${formatStatusSyncClock(salesAt, now)}` });
    }
    const tooltip = baseTooltip([
      salesAt ? `Last sync: ${tooltipStamp(salesAt)}` : "",
      "No server answer yet",
    ]);
    return {
      active: true,
      tone: "wait",
      pulse: true,
      titleLead: "Checking the server…",
      statusLead: "Checking the server…",
      statusParts,
      tooltip,
      ariaLabel: salesAt
        ? `Checking the server, last sync ${time(new Date(salesAt))}`
        : "Checking the server",
      caseId: "1",
    };
  }

  const reachable = api.reachable;

  if (reachable && syncNeedsAttention(journal)) {
    return deriveOnlineAttentionState(journal, twoWay, salesAt, stockAt, stock, api, now);
  }

  // Offline (3, 4, 5, T6) — red wins even when journal.issue is set
  if (!reachable) {
    if (twoWay && (salesAt || stockAt)) {
      const older = olderIso(salesAt, stockAt);
      const pillAge = older ? formatSyncedAgo(new Date(older), now) : undefined;
      const statusParts: TextPart[] = [];
      if (salesAt) statusParts.push({ text: `Sales sent ${formatDirectionClock(salesAt, now)}`, tone: "muted" });
      if (stockAt) statusParts.push({ text: `Stock updated ${formatDirectionClock(stockAt, now)}`, tone: "muted" });
      return {
        active: true,
        tone: "bad",
        pulse: false,
        titleLead: "Offline",
        titleDetail: pillAge ? `last synced ${pillAge}` : undefined,
        statusLead: "Offline",
        statusParts,
        tooltip: offlineTooltip(
          [
            "Can't reach the server",
            salesAt ? `Sales sent: ${tooltipStamp(salesAt)}` : "",
            stockAt ? `Stock updated: ${tooltipStamp(stockAt)}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          journal,
          api,
        ),
        ariaLabel: older
          ? `Offline, last sync ${time(new Date(older))}`
          : "Offline",
        caseId: "T6",
      };
    }

    if (!salesAt) {
      return {
        active: true,
        tone: "bad",
        pulse: false,
        titleLead: "Offline",
        titleDetail: "not synced yet",
        statusLead: "Offline",
        statusParts: [{ text: "not synced yet" }],
        tooltip: baseTooltip([
          "Can't reach the server. This counter hasn't synced yet",
        ]),
        ariaLabel: "Offline, not synced yet",
        caseId: "4",
      };
    }

    const age = formatSyncedAgo(new Date(salesAt), now);
    return {
      active: true,
      tone: "bad",
      pulse: false,
      titleLead: "Offline",
      titleDetail: `last synced ${age}`,
      statusLead: "Offline",
      statusParts: [{ text: `last sync ${formatStatusSyncClock(salesAt, now)}` }],
      tooltip: offlineTooltip(
        `Can't reach the server · Last sync: ${tooltipStamp(salesAt)}`,
        journal,
        api,
      ),
      ariaLabel: `Offline, last sync ${time(new Date(salesAt))}`,
      caseId: sameLocalDay(new Date(salesAt), now) ? "5" : "5b",
    };
  }

  // Syncing (state 2 + folded sales waiting) — before "never synced" (spec precedence 4 > 5)
  const blockedFromSyncing = syncNeedsAttention(journal);
  const salesWaiting =
    !blockedFromSyncing && journal.waiting > 0 && sales !== "overdue";
  const journalSyncing = !blockedFromSyncing && showJournalSyncing;
  const inSyncing = journalSyncing || salesWaiting;

  if (inSyncing) {
    if (twoWay) {
      const syncWord =
        journal.waiting > 0
          ? `↑ Syncing ${journal.waiting} sales`
          : "↑ Syncing";
      const parts: TextPart[] = [{ text: syncWord }];
      if (stockAt) parts.push({ text: `Stock updated ${formatDirectionClock(stockAt, now)}` });
      const tipLines = [
        journal.waiting > 0
          ? `Syncing · ${journal.waiting} sales waiting to send`
          : "Sending this counter's records to the server",
        salesAt ? `Sales sent: ${tooltipStamp(salesAt)}` : "",
        stockAt ? `Stock updated: ${tooltipStamp(stockAt)}` : "",
      ];
      return {
        active: true,
        tone: "info",
        pulse: true,
        titleLead: "Online",
        titleDetail: "syncing…",
        statusLead: "Online",
        statusParts: parts,
        tooltip: baseTooltip(tipLines),
        ariaLabel: "Online, syncing",
        caseId: "2-tw",
      };
    }

    const parts: TextPart[] = [{ text: "syncing now" }];
    if (salesAt) parts.push({ text: `last sync ${formatStatusSyncClock(salesAt, now)}` });
    return {
      active: true,
      tone: "info",
      pulse: true,
      titleLead: "Online",
      titleDetail: "syncing…",
      statusLead: "Online",
      statusParts: parts,
      tooltip: baseTooltip([
        journal.waiting > 0
          ? `Syncing · ${journal.waiting} sales waiting to send`
          : "Sending this counter's records to the server",
        salesAt ? `Last sync: ${tooltipStamp(salesAt)}` : "",
      ]),
      ariaLabel: "Online, syncing",
      caseId: "2",
    };
  }

  // Online — never synced (sales), after syncing branch
  if (sales === "never") {
    return {
      active: true,
      tone: "warn",
      pulse: false,
      titleLead: "Online",
      titleDetail: "not synced yet",
      statusLead: "Online",
      statusParts: [{ text: "not synced yet" }],
      tooltip: baseTooltip([
        "This counter hasn't finished a sync with the server yet",
      ]),
      ariaLabel: "Online, not synced yet",
      caseId: "3",
    };
  }

  // Two-way online outcomes
  if (twoWay && stock !== null) {
    const worst = worse(sales, stock);
    const older = olderIso(salesAt, stockAt);

    if (worst === "fresh" && canShowSynced(journal)) {
      const age = older ? formatSyncedAgo(new Date(older), now) : formatSyncedAgo(new Date(salesAt!), now);
      return {
        active: true,
        tone: "ok",
        pulse: false,
        titleLead: "Online",
        titleDetail: `synced ${age}`,
        statusLead: "Online",
        statusParts: [
          { text: `Sales sent ${formatDirectionClock(salesAt!, now)}` },
          { text: `Stock updated ${formatDirectionClock(stockAt!, now)}` },
        ],
        tooltip: baseTooltip([
          `Sales sent: ${tooltipStamp(salesAt!)}`,
          `Stock updated: ${tooltipStamp(stockAt!)}`,
        ]),
        ariaLabel: `Online, synced`,
        caseId: "T1",
      };
    }

    if (stock === "never" && sales === "fresh") {
      return {
        active: true,
        tone: "warn",
        pulse: false,
        titleLead: "Online",
        titleDetail: "stock not updated yet",
        statusLead: "Online",
        statusParts: [
          { text: `Sales sent ${formatDirectionClock(salesAt!, now)}` },
          { text: "Stock not updated yet", tone: "warn" },
        ],
        tooltip: baseTooltip([
          `Sales sent: ${tooltipStamp(salesAt!)}`,
          "Stock updated: not yet on this counter",
        ]),
        ariaLabel: "Online, stock not updated yet",
        caseId: "T3",
      };
    }

    if (stock === "overdue" && sales === "fresh") {
      const age = formatSyncedAgo(new Date(stockAt!), now);
      return {
        active: true,
        tone: "warn",
        pulse: false,
        titleLead: "Online",
        titleDetail: `stock overdue · ${age}`,
        statusLead: "Online",
        statusParts: [
          { text: `Sales sent ${formatDirectionClock(salesAt!, now)}` },
          { text: `⚠ Stock updated ${formatDirectionClock(stockAt!, now)}, overdue`, tone: "warn" },
        ],
        tooltip: baseTooltip([
          `Sales sent: ${tooltipStamp(salesAt!)}`,
          `Stock updated: ${tooltipStamp(stockAt!)} · overdue (over 15 min)`,
        ]),
        ariaLabel: "Online, stock overdue",
        caseId: "T2",
      };
    }

    if (sales === "overdue" && stock === "fresh") {
      const age = formatSyncedAgo(new Date(salesAt!), now);
      const tip = baseTooltip([
        `Sales sent: ${tooltipStamp(salesAt!)} · overdue (over 15 min)`,
        stockAt ? `Stock updated: ${tooltipStamp(stockAt)}` : "",
      ]);
      return {
        active: true,
        tone: "warn",
        pulse: false,
        titleLead: "Online",
        titleDetail: `sales overdue · ${age}`,
        statusLead: "Online",
        statusParts: [
          { text: `⚠ Sales sent ${formatDirectionClock(salesAt!, now)}, overdue`, tone: "warn" },
          ...(stockAt
            ? [{ text: `Stock updated ${formatDirectionClock(stockAt, now)}` } satisfies TextPart]
            : []),
        ],
        tooltip: tip,
        ariaLabel: "Online, sales overdue",
        caseId: "T4",
      };
    }

    if (sales === "overdue" && stock === "overdue") {
      const age = older ? formatSyncedAgo(new Date(older), now) : formatSyncedAgo(new Date(salesAt!), now);
      return {
        active: true,
        tone: "warn",
        pulse: false,
        titleLead: "Online",
        titleDetail: `sync overdue · ${age}`,
        statusLead: "Online",
        statusParts: [
          { text: `⚠ Sales sent ${formatDirectionClock(salesAt!, now)}, overdue`, tone: "warn" },
          { text: `⚠ Stock updated ${formatDirectionClock(stockAt!, now)}, overdue`, tone: "warn" },
        ],
        tooltip: baseTooltip([
          `Sales sent: ${tooltipStamp(salesAt!)} · overdue`,
          `Stock updated: ${tooltipStamp(stockAt!)} · overdue`,
        ]),
        ariaLabel: "Online, sync overdue",
        caseId: "T5",
      };
    }

    // Stock never with a non-fresh sales direction, or other mixed bad cases
    if (stock === "never") {
      const detail = "stock not updated yet";
      return {
        active: true,
        tone: "warn",
        pulse: false,
        titleLead: "Online",
        titleDetail: detail,
        statusLead: "Online",
        statusParts: [{ text: detail }],
        tooltip: baseTooltip([
          salesAt ? `Sales sent: ${tooltipStamp(salesAt)}` : "Sales sent: not yet",
          stockAt ? `Stock updated: ${tooltipStamp(stockAt)}` : "Stock updated: not yet on this counter",
        ]),
        ariaLabel: `Online, ${detail}`,
        caseId: "3-tw",
      };
    }

    // issue/pause blocks green — show sales overdue or worst warn
    if (sales === "overdue") {
      const age = formatSyncedAgo(new Date(salesAt!), now);
      return {
        active: true,
        tone: "warn",
        pulse: false,
        titleLead: "Online",
        titleDetail: `sales overdue · ${age}`,
        statusLead: "Online",
        statusParts: [
          { text: `⚠ Sales sent ${formatDirectionClock(salesAt!, now)}, overdue`, tone: "warn" },
          ...(stockAt
            ? [{ text: `Stock updated ${formatDirectionClock(stockAt, now)}` }]
            : []),
        ],
        tooltip: baseTooltip([
          `Sales sent: ${tooltipStamp(salesAt!)} · overdue`,
        ]),
        ariaLabel: "Online, sales overdue",
        caseId: "T4",
      };
    }
  }

  // Single-direction (T7 / sales-only / null nominated)
  if (sales === "overdue") {
    const age = formatSyncedAgo(new Date(salesAt!), now);
    return {
      active: true,
      tone: "warn",
      pulse: false,
      titleLead: "Online",
      titleDetail: `sync overdue · ${age}`,
      statusLead: "Online",
      statusParts: [{ text: `sync overdue · last sync ${formatStatusSyncClock(salesAt!, now)}` }],
      tooltip: baseTooltip([`Last sync: ${tooltipStamp(salesAt!)}`]),
      ariaLabel: "Online, sync overdue",
      caseId: "6",
    };
  }

  const salesOnly = journal.stockDownloadNominated !== true;

  if (canShowSynced(journal)) {
    const age = formatSyncedAgo(new Date(salesAt!), now);
    const statusParts: TextPart[] = salesOnly
      ? [{ text: `Sales sent ${formatDirectionClock(salesAt!, now)}` }]
      : [{ text: `last sync ${formatStatusSyncClock(salesAt!, now)}` }];
    return {
      active: true,
      tone: "ok",
      pulse: false,
      titleLead: "Online",
      titleDetail: `synced ${age}`,
      statusLead: "Online",
      statusParts,
      tooltip: baseTooltip([`Sales sent: ${tooltipStamp(salesAt!)}`]),
      ariaLabel: "Online, synced",
      caseId: salesOnly ? "T7" : "0",
    };
  }

  const reason =
    journal.pause?.reason === "draining"
      ? "Synchronising offline sales"
      : journal.pause?.reason === "unsynced"
        ? "Waiting to synchronise"
        : "Synchronisation paused";
  return {
    active: true,
    tone: "warn",
    pulse: false,
    titleLead: "Online",
    titleDetail: reason,
    statusLead: "Online",
    statusParts: [{ text: reason, tone: "warn" }],
    tooltip: baseTooltip([
      `Sales sent: ${tooltipStamp(salesAt!)}`,
      reason,
    ]),
    ariaLabel: "Online, synchronisation paused",
    caseId: "0-blocked",
  };
}

/** The status bar's offline-backup segment (mockup #103): grant expiry from the readiness report. */
export function offlineBackupReadyUntil(
  backup: OfflineBackup | null | undefined,
  now = new Date(),
): string | null {
  if (!backup?.grantExpiresAt || !backup.usable) return null;
  const expiresMs = Date.parse(backup.grantExpiresAt);
  if (Number.isNaN(expiresMs) || now.getTime() >= expiresMs) return null;
  return `ready until ${time(new Date(expiresMs))}`;
}
