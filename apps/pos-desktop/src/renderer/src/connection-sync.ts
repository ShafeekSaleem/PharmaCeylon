import type { ApiReachability, JournalSync, OfflineBackup } from "../../shared/ipc-contract";
import { time, timeWithSeconds } from "./format";

/** Relative sync age for the title bar pill, matching the mockup's "8 s ago" style. */
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

/**
 * The mockup (#103) draws only the healthy online case: Online · synced … ago / last sync HH:MM:SS.
 * Until Design approves other cases, those fall back to the existing reachability pill (P2b #103).
 */
export function showLastSyncPill(
  enrollmentStatus: "pending" | "active" | "revoked" | "retired" | undefined,
  api: ApiReachability | null,
  journal: JournalSync | null,
): boolean {
  return (
    enrollmentStatus === "active" &&
    api?.reachable === true &&
    Boolean(journal?.lastSuccessAt) &&
    !journal?.syncing
  );
}

export function lastSyncLabels(lastSuccessAt: string, now: Date): {
  detailAgo: string;
  detailClock: string;
} {
  const at = new Date(lastSuccessAt);
  return {
    detailAgo: `synced ${formatSyncedAgo(at, now)}`,
    detailClock: `last sync ${timeWithSeconds(at)}`,
  };
}

/** The status bar's offline-backup segment (mockup #103): grant expiry from the readiness report. */
export function offlineBackupReadyUntil(
  backup: OfflineBackup | null | undefined,
): string | null {
  if (!backup?.grantExpiresAt || !backup.usable) return null;
  return `ready until ${time(new Date(backup.grantExpiresAt))}`;
}
