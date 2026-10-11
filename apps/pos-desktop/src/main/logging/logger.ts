import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./redact";

export type LogLevel = "info" | "warn" | "error";

export type Logger = Record<LogLevel, (event: string, data?: Record<string, unknown>) => void> & {
  flush(): Promise<void>;
};

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEPT_FILES = 3;

/**
 * JSON-lines log, redacted on the way in and capped at KEPT_FILES files of
 * MAX_FILE_BYTES. Writes are queued so a caller never waits on the disk.
 */
export function createLogger(logDir: string): Logger {
  const file = join(logDir, "pos.log");
  let size: number | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function rotate(): Promise<void> {
    await rm(`${file}.${KEPT_FILES - 1}`, { force: true });
    for (let i = KEPT_FILES - 2; i >= 1; i--) {
      await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => undefined);
    }
    await rename(file, `${file}.1`).catch(() => undefined);
    size = 0;
  }

  async function write(line: string): Promise<void> {
    if (size === null) {
      await mkdir(logDir, { recursive: true });
      size = await stat(file).then(
        (s) => s.size,
        () => 0,
      );
    }
    const bytes = Buffer.byteLength(line);
    if (size + bytes > MAX_FILE_BYTES) await rotate();
    await appendFile(file, line, "utf8");
    size += bytes;
  }

  function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), level, event, ...(redact(data ?? {}) as object) })}\n`;
    // Logging must never take the app down with it.
    queue = queue.then(() => write(line)).catch(() => undefined);
  }

  return {
    info: (event, data) => log("info", event, data),
    warn: (event, data) => log("warn", event, data),
    error: (event, data) => log("error", event, data),
    flush: () => queue,
  };
}
