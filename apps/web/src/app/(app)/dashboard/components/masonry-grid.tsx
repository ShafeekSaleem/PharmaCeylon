"use client";

import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import css from "../dashboard.module.css";

const COLS = 3;
/** Matches grid-auto-rows / gap in dashboard.module.css. */
const ROW_UNIT = 4;
const ROW_GAP = 11;
/** Row-span is rounded up to this bucket so panels with near-identical
 * content (a donut chart, a stat strip) snap to one shared height instead of
 * differing by a few px of natural layout noise. Genuinely longer content
 * (a 6-row table) still lands in a taller bucket. Kept small — each bucket
 * step reserves up to ROW_BUCKET*(ROW_UNIT+ROW_GAP)px of slack before the
 * next row in that column, which is left as quiet page background rather
 * than stretched into the card (see masonryItem's align-self: start). */
const ROW_BUCKET = 2;

type ItemProps = {
  /** Width in thirds of the grid. Only the lead panel should be 2. */
  span?: 1 | 2;
  children: ReactNode;
};

/** Prop carrier only — MasonryGrid reads `span`/`children` off these directly
 * and positions them itself, so the DOM order stays intact for measurement. */
export function MasonryItem({ children }: ItemProps) {
  return <>{children}</>;
}

type Placement = { col: number; rowStart: number; rowSpan: number; span: number };

function pickColumn(colHeights: number[], span: number): number {
  let bestCol = 0;
  let bestMax = Infinity;
  for (let c = 0; c <= COLS - span; c++) {
    const maxH = Math.max(...colHeights.slice(c, c + span));
    if (maxH < bestMax) {
      bestMax = maxH;
      bestCol = c;
    }
  }
  return bestCol;
}

/** True masonry: each item (in DOM order) goes into whichever column is
 * currently shortest, so it both fills left-to-right (ties favor the lower
 * column index) and leaves no gaps (unlike CSS `grid-auto-flow: dense`,
 * which backfills with *later* items and can visibly reorder the page). */
export function MasonryGrid({ children }: { children: ReactNode }) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<ItemProps>[];
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [containerHeight, setContainerHeight] = useState<number | undefined>(undefined);
  const rafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const recompute = () => {
      const colHeights = new Array(COLS).fill(0);
      const next: Placement[] = items.map((item, i) => {
        const span = Math.min(item.props.span ?? 1, COLS);
        const el = refs.current[i];
        const h = el ? el.getBoundingClientRect().height : 80;
        const rawRowSpan = Math.max(1, Math.ceil((h + ROW_GAP) / (ROW_UNIT + ROW_GAP)));
        const rowSpan = Math.ceil(rawRowSpan / ROW_BUCKET) * ROW_BUCKET;
        const col = pickColumn(colHeights, span);
        const rowStart = Math.max(...colHeights.slice(col, col + span)) + 1;
        for (let c = col; c < col + span; c++) colHeights[c] = rowStart + rowSpan - 1;
        return { col, rowStart, rowSpan, span };
      });
      setPlacements(next);
      const tallestRow = Math.max(0, ...colHeights);
      setContainerHeight(tallestRow * ROW_UNIT + Math.max(0, tallestRow - 1) * ROW_GAP);
    };

    const scheduleRecompute = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(recompute);
    };

    recompute();
    const ro = new ResizeObserver(scheduleRecompute);
    refs.current.forEach((el) => el && ro.observe(el));
    window.addEventListener("resize", scheduleRecompute);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", scheduleRecompute);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  return (
    <div className={css.masonryGrid} style={containerHeight ? { height: containerHeight } : undefined}>
      {items.map((item, i) => {
        const span = Math.min(item.props.span ?? 1, COLS);
        const placed = placements[i];
        return (
          <div
            key={item.key ?? i}
            className={css.masonryItem}
            style={
              placed
                ? {
                    gridColumn: `${placed.col + 1} / span ${placed.span}`,
                    gridRow: `${placed.rowStart} / span ${placed.rowSpan}`,
                  }
                : { gridColumn: `span ${span}` }
            }
          >
            {/* Measured directly — not a grid item itself, so its height
                reflects real content instead of the grid track we're
                computing from it (which would otherwise be circular). */}
            <div
              ref={(el) => {
                refs.current[i] = el;
              }}
              className={css.masonryItemInner}
            >
              {item.props.children}
            </div>
          </div>
        );
      })}
    </div>
  );
}
