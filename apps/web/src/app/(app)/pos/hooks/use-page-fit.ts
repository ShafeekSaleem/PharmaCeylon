"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

type Options = {
  /** Items a page where the box grows to fit them (phones) and before anything is measured. */
  fallback: number;
  /** Matches one rendered item, to measure its height. */
  itemSelector: string;
  /** Height to assume until an item has rendered. */
  itemHeight: number;
  /** Lay items out in as many columns of at least this width as fit; one column when omitted. */
  minColumnWidth?: number;
  gap?: number;
};

/**
 * How many items a page holds so a paged list fills its box without scrolling: rows that fit the
 * box's height times columns that fit its width. Re-measured when the box resizes or the first
 * item renders.
 */
export function usePageFit<T extends HTMLElement>({
  fallback,
  itemSelector,
  itemHeight,
  minColumnWidth,
  gap = 10,
}: Options) {
  const [box, setBox] = useState<T | null>(null);
  const [fit, setFit] = useState({ perPage: fallback, columns: 1 });

  const measure = useCallback(() => {
    if (!box) return;
    let next = { perPage: fallback, columns: 1 };
    if (window.innerWidth > 960) {
      const columns = minColumnWidth
        ? Math.max(1, Math.floor((box.clientWidth + gap) / (minColumnWidth + gap)))
        : 1;
      const item = box.querySelector<HTMLElement>(itemSelector);
      const height = item?.offsetHeight || itemHeight;
      const rows = Math.max(1, Math.floor((box.clientHeight + gap) / (height + gap)));
      next = { perPage: rows * columns, columns };
    }
    setFit((prev) => (prev.perPage === next.perPage && prev.columns === next.columns ? prev : next));
  }, [box, fallback, itemSelector, itemHeight, minColumnWidth, gap]);

  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box, measure]);

  // The first item's real height arrives after it renders; settles in one extra render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure);

  return { ref: setBox, ...fit };
}
