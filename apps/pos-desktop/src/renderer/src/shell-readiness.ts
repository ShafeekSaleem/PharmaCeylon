import { useEffect, useRef } from "react";

/** Local IPC read; keep the status bar's offline-backup expiry in step with main. */
export const READINESS_POLL_MS = 60_000;

/** Poll readiness while the shell is active; re-read when server reachability flips. */
export function useShellReadinessPoll(
  active: boolean,
  refreshReadiness: () => void,
  apiReachable: boolean | null | undefined,
): void {
  const prevReachable = useRef<boolean | null | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    refreshReadiness();
    const timer = window.setInterval(refreshReadiness, READINESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refreshReadiness]);

  useEffect(() => {
    if (!active || apiReachable == null) return;
    const prev = prevReachable.current;
    prevReachable.current = apiReachable;
    if (prev !== undefined && prev !== apiReachable) refreshReadiness();
  }, [active, apiReachable, refreshReadiness]);
}
