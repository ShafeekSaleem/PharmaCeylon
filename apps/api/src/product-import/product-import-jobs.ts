import type { ImportResult } from "./product-import.types";

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export type ImportJobSnapshot = {
  jobId: string;
  tenantId: string;
  importId: string;
  status: ImportJobStatus;
  phase: string;
  processed: number;
  total: number;
  productsCreated: number;
  productsUpdated: number;
  batchesCreated: number;
  errorCount: number;
  result?: ImportResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

/** Public progress payload (no tenantId). */
export type ImportJobProgress = Omit<
  ImportJobSnapshot,
  "tenantId" | "createdAt" | "updatedAt"
>;

/**
 * In-memory progress, mirroring the NMRA importer's job map: fast ticks that would be wasteful
 * as database writes. The durable record of what an import did lives in the `ProductImport`
 * row, so losing this map to a restart costs progress polling, never the audit trail or undo.
 */
const TTL_MS = 30 * 60 * 1000;
const jobs = new Map<string, ImportJobSnapshot>();

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > TTL_MS) jobs.delete(id);
  }
}

export function createImportJob(
  jobId: string,
  tenantId: string,
  importId: string,
): ImportJobSnapshot {
  pruneJobs();
  const now = Date.now();
  const job: ImportJobSnapshot = {
    jobId,
    tenantId,
    importId,
    status: "queued",
    phase: "preparing",
    processed: 0,
    total: 0,
    productsCreated: 0,
    productsUpdated: 0,
    batchesCreated: 0,
    errorCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(jobId, job);
  return job;
}

export function patchImportJob(
  jobId: string,
  patch: Partial<Omit<ImportJobSnapshot, "jobId" | "tenantId" | "createdAt">>,
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

export function getImportJob(jobId: string): ImportJobSnapshot | undefined {
  return jobs.get(jobId);
}

export function toImportJobProgress(job: ImportJobSnapshot): ImportJobProgress {
  return {
    jobId: job.jobId,
    importId: job.importId,
    status: job.status,
    phase: job.phase,
    processed: job.processed,
    total: job.total,
    productsCreated: job.productsCreated,
    productsUpdated: job.productsUpdated,
    batchesCreated: job.batchesCreated,
    errorCount: job.errorCount,
    result: job.result,
    error: job.error,
  };
}
