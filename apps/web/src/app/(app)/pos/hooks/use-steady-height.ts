"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

/**
 * Keeps a paged list at the tallest height it has shown while its popup is open, so a short last
 * page or a narrow search doesn't shrink the popup and make it jump. Resets when the popup closes.
 */
export function useSteadyHeight<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);

  // Measured after every render on purpose: a page change or a search changes the content.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = el.offsetHeight;
    // It only ever grows, so this settles after one extra render.
    setHeight((prev) => (next > prev ? next : prev));
  });

  useEffect(() => {
    if (!open) setHeight(0);
  }, [open]);

  const style: CSSProperties | undefined = height
    ? { minHeight: height }
    : undefined;
  return { ref, style };
}
