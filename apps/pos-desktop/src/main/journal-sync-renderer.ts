import type { JournalSync } from "../shared/ipc-contract";
import type { PosDatabase } from "./db/database";
import { readInstalledSnapshotGeneratedAt } from "./terminal/offline-authority";
import type { OfflineAuthorityRefreshStatus } from "./terminal/offline-authority-refresh";
import { journalSyncState, type JournalSyncView } from "./terminal/offline-journal-sync";

type GeneratedAtCacheEntry = { version: number; iso: string };

const generatedAtByEnrollment = new Map<string, GeneratedAtCacheEntry>();

/** Clears the stock-generated-at cache (tests). */
export function resetJournalSyncRendererCache(): void {
  generatedAtByEnrollment.clear();
}

function lastStockDownloadAt(db: PosDatabase, enrollmentId: string): string | null {
  const row = readInstalledSnapshotGeneratedAt(db, enrollmentId);
  if (!row) {
    generatedAtByEnrollment.delete(enrollmentId);
    return null;
  }
  const hit = generatedAtByEnrollment.get(enrollmentId);
  if (hit && hit.version === row.version) return hit.iso;
  const iso = new Date(row.generatedAt).toISOString();
  generatedAtByEnrollment.set(enrollmentId, { version: row.version, iso });
  return iso;
}

/** Desktop IPC enrichment for the renderer poll (`getJournalSync`). Kept out of offline-journal-sync.ts (P5). */
export function journalSyncForRenderer(
  view: JournalSyncView | null,
  db: PosDatabase | null,
  enrollmentId: string | undefined,
  refresh: OfflineAuthorityRefreshStatus | null,
): JournalSync {
  const base = journalSyncState(view);
  if (!db || !enrollmentId) return base;
  return {
    ...base,
    lastStockDownloadAt: lastStockDownloadAt(db, enrollmentId),
    stockDownloadNominated: refresh?.nominated ?? null,
  };
}
