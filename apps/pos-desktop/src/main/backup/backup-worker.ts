import { parentPort, workerData } from "node:worker_threads";
import {
  openCipherFile,
  writeBackupCopy,
  type BackupCopyJob,
  type BackupWorkerReply,
} from "./store-backup";

/**
 * #166: writes one store backup copy off the main process, so checkout never waits for it. Run by
 * `workerCopyRunner` in a fresh worker thread per backup; built as its own entry beside the main
 * bundle (`dist/main/backup-worker.js`).
 *
 * It opens its own connection to the live store (WAL mode: the till's connection keeps writing
 * while this one reads one consistent snapshot) and only ever reads it (the copy is attached to that connection under its own key). The keys arrive in
 * `workerData` and never leave: a failure is reported by name, code and message only, and no
 * SQLite message carries a key.
 */
function run(job: BackupCopyJob): BackupWorkerReply {
  try {
    // Writable only so the copy can be attached to it; the live store itself is only read.
    const source = openCipherFile(job.storePath, job.liveKey);
    try {
      return { ok: true, result: writeBackupCopy(source, job) };
    } finally {
      source.close();
    }
  } catch (error) {
    const failure = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
    };
    return {
      ok: false,
      error: {
        name: typeof failure.name === "string" ? failure.name : "Error",
        message:
          typeof failure.message === "string"
            ? failure.message
            : "The backup copy failed.",
        code: typeof failure.code === "string" ? failure.code : undefined,
      },
    };
  }
}

parentPort?.postMessage(run(workerData as BackupCopyJob));
