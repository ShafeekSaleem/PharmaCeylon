import { useEffect, useRef, useState } from "react";

/**
 * Anti-flicker for journal.syncing (spec #103): show "syncing" only after ~1 s of a cycle, and
 * keep it visible for at least 1 s after syncing ends so the pill does not flash reachability copy.
 */
export function useSyncingLatch(syncing: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  visibleRef.current = visible;

  useEffect(() => {
    let timer: number | undefined;
    if (syncing) {
      timer = window.setTimeout(() => {
        visibleRef.current = true;
        setVisible(true);
      }, 1000);
    } else if (visibleRef.current) {
      timer = window.setTimeout(() => {
        visibleRef.current = false;
        setVisible(false);
      }, 1000);
    } else {
      setVisible(false);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [syncing]);

  return visible;
}
