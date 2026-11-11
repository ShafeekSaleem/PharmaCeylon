import { useEffect, useRef, useState } from "react";

export const SYNCING_LATCH_MS = 1000;

/**
 * Anti-flicker for journal.syncing (spec #103): show syncing only after ~1 s, and keep it for at
 * least 1 s after syncing ends. Callers should use this value directly (not `journal.syncing &&`).
 */
export function useSyncingLatch(syncing: boolean, delayMs = SYNCING_LATCH_MS): boolean {
  const [latched, setLatched] = useState(false);
  const latchedRef = useRef(false);
  latchedRef.current = latched;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (syncing) {
      timer = setTimeout(() => {
        latchedRef.current = true;
        setLatched(true);
      }, delayMs);
    } else if (latchedRef.current) {
      timer = setTimeout(() => {
        latchedRef.current = false;
        setLatched(false);
      }, delayMs);
    } else {
      setLatched(false);
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [syncing, delayMs]);

  return latched;
}
