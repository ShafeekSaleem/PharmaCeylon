import type { HealthStatus } from "@pharmaceylon/shared";
import type { ApiReachability } from "../shared/ipc-contract";

const TIMEOUT_MS = 4000;

/** Unauthenticated reachability only. It never renews or extends anything. */
export async function checkApi(
  apiBaseUrl: string | null,
  fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
  now: () => number = Date.now,
): Promise<ApiReachability> {
  const startedAt = now();
  let reachable = false;
  if (apiBaseUrl) {
    try {
      const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      reachable = response.ok && ((await response.json()) as Partial<HealthStatus>).ok === true;
    } catch {
      reachable = false;
    }
  }
  const finishedAt = now();
  return {
    reachable,
    checkedAt: new Date(finishedAt).toISOString(),
    latencyMs: reachable ? finishedAt - startedAt : null,
  };
}
