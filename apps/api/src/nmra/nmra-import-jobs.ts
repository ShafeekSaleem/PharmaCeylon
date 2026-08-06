import type { NmraImportResult } from "./nmra-import.types";

export type NmraJobStatus = "queued" | "running" | "completed" | "failed";

export type NmraJobSnapshot = {
  jobId: string;
  tenantId: string;
  status: NmraJobStatus;
  phase: string;
  processed: number;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errorCount: number;
  result?: NmraImportResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

/** Public progress payload (no tenantId). */
export type NmraJobProgress = Omit<NmraJobSnapshot, "tenantId" | "createdAt" | "updatedAt">;

const TTL_MS = 30 * 60 * 1000;
const jobs = new Map<string, NmraJobSnapshot>();

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > TTL_MS) jobs.delete(id);
  }
}

export function createNmraJob(jobId: string, tenantId: string): NmraJobSnapshot {
  pruneJobs();
  const now = Date.now();
  const job: NmraJobSnapshot = {
    jobId,
    tenantId,
    status: "queued",
    phase: "preparing",
    processed: 0,
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errorCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(jobId, job);
  return job;
}

export function patchNmraJob(
  jobId: string,
  patch: Partial<Omit<NmraJobSnapshot, "jobId" | "tenantId" | "createdAt">>,
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

export function getNmraJob(jobId: string): NmraJobSnapshot | undefined {
  return jobs.get(jobId);
}

export function toNmraJobProgress(job: NmraJobSnapshot): NmraJobProgress {
  return {
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    processed: job.processed,
    total: job.total,
    created: job.created,
    updated: job.updated,
    skipped: job.skipped,
    errorCount: job.errorCount,
    result: job.result,
    error: job.error,
  };
}
