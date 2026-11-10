import type { SecretProtector } from "../db/key-store";
import type { Migration } from "../db/migrator";
import { openLocalStore, type LocalStore } from "../local-store";
import {
  listStoreBackups,
  readStoreFacts,
  takeStoreBackup,
  type StoreBackup,
} from "./store-backup";
import {
  finishInterruptedRestore,
  liveStoreState,
  restoreStoreBackup,
  type AppliedRestore,
} from "./store-restore";

/** What the person at the computer is asked, and told. The app shows native dialogs; tests answer. */
export type RestorePrompt = {
  /** The store could not be opened. A backup to restore, or null to quit. */
  afterFailure(
    error: unknown,
    backups: readonly StoreBackup[],
  ): StoreBackup | null;
  /** The store opened but holds no counter, and this computer has backups of one. Null: carry on. */
  forEmptyStore(backups: readonly StoreBackup[]): StoreBackup | null;
};

export type StartupOutcome =
  | { kind: "open"; store: LocalStore }
  /** A backup was restored: start again on it. */
  | { kind: "restored"; backup: StoreBackup; applied: AppliedRestore | null }
  /** The store cannot be opened and nothing was restored. */
  | { kind: "failed"; error: unknown };

const withCounter = (backups: readonly StoreBackup[]) =>
  backups.filter((b) => b.manifest.enrollmentId !== null);

/**
 * Opening the store at start-up (P5 #51). Finishes an interrupted restore first; backs up before a
 * schema upgrade; and offers a restore only where one is allowed — the store cannot be opened, or
 * it opens with no counter in it — never over a working store. `restoreStoreBackup` checks that
 * again for itself.
 */
export function openStoreAtStartup(options: {
  dataDir: string;
  backupsDir: string;
  protector: SecretProtector;
  migrations: readonly Migration[];
  appVersion: string;
  prompt: RestorePrompt;
  report: (event: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}): StartupOutcome {
  const interrupted = finishInterruptedRestore(options.dataDir);
  if (interrupted !== "none")
    options.report("store_restore.interrupted", { outcome: interrupted });
  const restore = (backup: StoreBackup): StartupOutcome => {
    const applied = restoreStoreBackup({ ...options, backup });
    options.report("store_restore.restored", {
      backupId: backup.manifest.backupId,
      takenAt: backup.manifest.takenAt,
      restoreId: applied?.restoreId ?? null,
    });
    return { kind: "restored", backup, applied };
  };

  let store: LocalStore;
  try {
    store = openLocalStore(
      options.dataDir,
      options.protector,
      options.migrations,
      {
        beforeUpgrade: ({ db, keyPath, from }) => {
          if (!readStoreFacts(db).enrollmentId) return;
          try {
            takeStoreBackup(db, {
              ...options,
              keyPath,
              reason: "before_upgrade",
            });
          } catch (error) {
            // A failed backup never stops the till; the upgrade itself is transactional per step.
            options.report("store_backup.before_upgrade_failed", {
              from,
              error,
            });
          }
        },
      },
    );
  } catch (error) {
    // It opens and holds a counter, but this app can't use it (a newer schema, an upgrade that
    // failed): never offer to restore over it.
    if (liveStoreState(options.dataDir, options.protector) === "working")
      return { kind: "failed", error };
    const backups = withCounter(listStoreBackups(options.backupsDir));
    const chosen = backups.length
      ? options.prompt.afterFailure(error, backups)
      : null;
    if (!chosen) return { kind: "failed", error };
    try {
      return restore(chosen);
    } catch (restoreError) {
      return { kind: "failed", error: restoreError };
    }
  }

  if (readStoreFacts(store.db).enrollmentId === null) {
    const backups = withCounter(listStoreBackups(options.backupsDir));
    const chosen = backups.length
      ? options.prompt.forEmptyStore(backups)
      : null;
    if (chosen) {
      store.db.close();
      try {
        return restore(chosen);
      } catch (error) {
        options.report("store_restore.failed", { error });
        // The empty store is still there and still empty: carry on with it.
        return {
          kind: "open",
          store: openLocalStore(
            options.dataDir,
            options.protector,
            options.migrations,
          ),
        };
      }
    }
  }
  return { kind: "open", store };
}
