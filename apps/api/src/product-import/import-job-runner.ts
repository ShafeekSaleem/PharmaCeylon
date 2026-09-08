import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { tenantTransactionStorage } from "../prisma/tenant-transaction.store";
import { PrismaService } from "../prisma/prisma.service";
import {
  createImportJob,
  getImportJob,
  patchImportJob,
  toImportJobProgress,
  type ImportJobProgress,
} from "./product-import-jobs";
import type { ImportResult } from "./product-import.types";

/**
 * Runs product-import jobs so that a restart can't lose one.
 *
 * The importer used to track jobs only in a process-local `Map`. Two things followed from that,
 * both bad: an import interrupted by a deploy stayed `running` in the database forever, with no
 * way for an operator to tell whether it had finished or died; and with more than one API
 * instance, the progress poll could land on a process that had never heard of the job and
 * answer 404 while the import ran happily elsewhere.
 *
 * This keeps the in-memory map as a fast tier — sub-second progress ticks are genuinely not
 * worth a write each — but makes the database the source of truth:
 *
 * - phase / processed / total are mirrored onto the `product_import` row, throttled, so any
 *   instance can answer a progress poll for any job;
 * - a running job heartbeats, and a sweep moves jobs whose heartbeat has gone stale to
 *   `failed`, which is the state an operator can act on (products already created are kept and
 *   the run can be repeated for the rest — see `undo` for the other direction);
 * - the sweep runs at boot and periodically, so a crash during a deploy is cleaned up by
 *   whichever instance comes back first.
 *
 * Deliberately not a queue. Adding Redis/BullMQ for one endpoint would be a larger change to
 * the deployment than the problem justifies, and the recovery story a queue buys — automatic
 * resumption mid-file — needs the parsed rows to be durable too, which is a separate piece of
 * work. What is guaranteed here is that a job never sits in a lie.
 */

/** A running job must touch its heartbeat at least this often. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Older than this without a heartbeat and the job is presumed dead. */
const STALE_AFTER_MS = 90_000;
/** How often the sweep looks for dead jobs. */
const SWEEP_INTERVAL_MS = 60_000;
/** Progress is mirrored to the database at most this often. */
const PROGRESS_FLUSH_MS = 2_000;

export const INTERRUPTED_MESSAGE =
  "Interrupted before it finished (the server restarted or the process stopped). " +
  "Any products and stock already created were kept. Review Recent imports and undo the " +
  "untouched import before uploading again; if stock has moved, reconcile only missing rows.";

/** What the running import calls to report progress. */
export type ImportJobContext = {
  jobId: string;
  importId: string;
  /** Merge progress fields. Cheap — writes to memory always, to the database at most every 2s. */
  progress(patch: {
    phase?: string;
    processed?: number;
    total?: number;
    productsCreated?: number;
    productsUpdated?: number;
    batchesCreated?: number;
    errorCount?: number;
  }): void;
};

@Injectable()
export class ImportJobRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportJobRunner.name);
  private sweepTimer?: NodeJS.Timeout;
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly lastFlush = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.sweepStale();
    this.sweepTimer = setInterval(() => {
      void this.sweepStale();
    }, SWEEP_INTERVAL_MS);
    // Never hold the process open just to sweep.
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
  }

  /**
   * Start `work` as a background import job.
   *
   * Returns as soon as the job is registered — the caller responds to the HTTP request while
   * the work continues. Failures are captured onto the import row rather than escaping into an
   * unhandled rejection, which is how a failed import used to become an invisible one.
   */
  start(
    jobId: string,
    tenantId: string,
    importId: string,
    work: (ctx: ImportJobContext) => Promise<ImportResult | void>,
  ): void {
    createImportJob(jobId, tenantId, importId);
    patchImportJob(jobId, { status: "running", phase: "starting" });

    const ctx: ImportJobContext = {
      jobId,
      importId,
      progress: (patch) => {
        patchImportJob(jobId, patch);
        this.maybeFlush(jobId, tenantId, importId, patch);
      },
    };

    // Background work must not inherit the HTTP request's soon-to-close RLS transaction.
    void tenantTransactionStorage
      .exit(async () => {
        await this.markRunning(importId, tenantId);
        this.startHeartbeat(jobId, tenantId, importId);
        await work(ctx);
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : "Import failed";
        this.logger.error(`Import ${importId} failed: ${message}`);
        patchImportJob(jobId, {
          status: "failed",
          phase: "failed",
          error: message,
        });
        await this.prisma.productImport
          .updateMany({
            where: { id: importId, tenantId, status: "running" },
            data: {
              status: "failed",
              error: message,
              completedAt: new Date(),
              heartbeatAt: null,
            },
          })
          .catch(() => undefined);
      })
      .finally(() => {
        this.stopHeartbeat(jobId);
        void this.prisma.productImport
          .updateMany({
            where: { id: importId, tenantId, status: "running" },
            data: { heartbeatAt: null },
          })
          .catch(() => undefined);
      });
  }

  /**
   * Progress for a job, from memory when this instance is running it and from the database
   * otherwise. The database fallback is what makes the progress poll survive both a restart
   * and a load balancer sending the poll to a different instance than the upload.
   */
  async getProgress(
    tenantId: string,
    jobId: string,
  ): Promise<ImportJobProgress> {
    // `jobId` and `importId` are the same value by construction (see `startImport`), so a job
    // this process never saw is still findable by its import row.
    const row = await this.prisma.productImport.findFirst({
      where: { id: jobId, tenantId },
      select: {
        id: true,
        status: true,
        phase: true,
        rowsProcessed: true,
        rowsTotal: true,
        productsCreated: true,
        productsUpdated: true,
        batchesCreated: true,
        rowsFailed: true,
        error: true,
        result: true,
      },
    });
    if (!row) throw new NotFoundException("Import job not found.");

    return {
      jobId: row.id,
      importId: row.id,
      status:
        row.status === "completed"
          ? "completed"
          : row.status === "running"
            ? "running"
            : "failed",
      phase: row.phase ?? (row.status === "completed" ? "done" : row.status),
      processed: row.rowsProcessed,
      total: row.rowsTotal,
      productsCreated: row.productsCreated,
      productsUpdated: row.productsUpdated,
      batchesCreated: row.batchesCreated,
      errorCount: row.rowsFailed,
      error: row.error ?? undefined,
      result: row.result ? (row.result as unknown as ImportResult) : undefined,
    };
  }

  /**
   * Move every `running` import whose heartbeat has gone stale to `failed`.
   *
   * Runs on boot and on a timer. Rows with no heartbeat at all are covered too — an import
   * started by an older build, or one that died between `create` and its first heartbeat —
   * using `createdAt` as the fallback clock.
   */
  async sweepStale(): Promise<number> {
    // Guarded because the sweep runs on module init, which unit tests reach with a partial
    // Prisma stand-in — a missing model there is a test harness detail, not an incident.
    if (typeof this.prisma?.productImport?.updateMany !== "function") return 0;
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    try {
      /*
       * Runs with no tenant context by design. A restart strands `running` rows across every
       * tenant at once; a per-tenant sweep would need a tenant list to iterate and would
       * silently skip any tenant nobody happened to log into afterwards. The filter is narrow
       * where it matters — only rows this process can prove are dead — and the only write it
       * makes is `running` → `failed`.
       */
      // tenant-scope: system-auth — boot/interval recovery sweep, not a request path.
      const result = await this.prisma.productImport.updateMany({
        where: {
          status: "running",
          OR: [
            { heartbeatAt: { lt: cutoff } },
            { heartbeatAt: null, createdAt: { lt: cutoff } },
          ],
        },
        data: {
          status: "failed",
          error: INTERRUPTED_MESSAGE,
          completedAt: new Date(),
          heartbeatAt: null,
        },
      });
      if (result.count > 0) {
        this.logger.warn(
          `Recovered ${result.count} interrupted product import(s) — marked failed so they can be re-run.`,
        );
      }
      return result.count;
    } catch (err) {
      // A sweep failure must never take the process down; the next tick tries again.
      this.logger.error(
        `Import sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  private async markRunning(importId: string, tenantId: string): Promise<void> {
    const claimed = await this.prisma.productImport.updateMany({
      where: { id: importId, tenantId, status: "running" },
      data: { phase: "starting", heartbeatAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error("Import is no longer running");
  }

  private startHeartbeat(
    jobId: string,
    tenantId: string,
    importId: string,
  ): void {
    const timer = setInterval(() => {
      void this.prisma.productImport
        .updateMany({
          where: { id: importId, tenantId, status: "running" },
          data: { heartbeatAt: new Date() },
        })
        .catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    this.heartbeats.set(jobId, timer);
  }

  private stopHeartbeat(jobId: string): void {
    const timer = this.heartbeats.get(jobId);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(jobId);
    this.lastFlush.delete(jobId);
  }

  /** Mirror progress to the database, but no more than once every `PROGRESS_FLUSH_MS`. */
  private maybeFlush(
    jobId: string,
    tenantId: string,
    importId: string,
    patch: { phase?: string; processed?: number; total?: number },
  ): void {
    const now = Date.now();
    const last = this.lastFlush.get(jobId) ?? 0;
    // A phase change is always worth a write — it is what the progress UI actually renders.
    if (now - last < PROGRESS_FLUSH_MS && patch.phase === undefined) return;
    this.lastFlush.set(jobId, now);

    void this.prisma.productImport
      .updateMany({
        where: { id: importId, tenantId, status: "running" },
        data: {
          ...(patch.phase !== undefined
            ? { phase: patch.phase.slice(0, 32) }
            : {}),
          ...(patch.processed !== undefined
            ? { rowsProcessed: patch.processed }
            : {}),
          ...(patch.total !== undefined ? { rowsTotal: patch.total } : {}),
          heartbeatAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}
