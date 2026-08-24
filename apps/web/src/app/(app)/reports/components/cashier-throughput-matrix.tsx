"use client";

import { useEffect, useState } from "react";
import { resolveBubbleCollisions } from "../lib/bubble-layout";
import css from "../reports.module.css";

export type CashierMatrixPoint = { id: string; label: string; transactions: number; avgBasket: number; revenue: number };

type Props = {
  points: CashierMatrixPoint[];
  formatValue: (n: number) => string;
  /** One color per cashier — lets a cashier read as the same color here and in the Cashier Detail
   *  table below, the same "one entity, one color" convention Branch Sales' own matrix uses. */
  colorFor: (id: string) => string;
  onBubbleClick?: (id: string) => void;
  activeId?: string | null;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// Keeps every bubble's own circle (not just its center) clear of the plot's border — a bubble
// centered exactly at the collision-resolved edge would otherwise still touch the border with zero
// breathing room. The safe zone is laid out/collision-resolved in its own coordinate space, then
// offset back into the full plot for rendering.
const EDGE_PAD = 16;

/** Transactions × average basket value, bubble size = revenue — a side-by-side comparison of how
 *  cashiers convert footfall into revenue (through sales volume vs. basket size), not a
 *  performance scorecard. Colored per-cashier rather than by quadrant — there's no inherent
 *  "good"/"bad" quadrant for transactions×basket the way there is for revenue×margin, so a
 *  manufactured quadrant taxonomy would just be noise; dashed reference lines at the median
 *  transactions/basket still divide the plot into four readable quadrants. Same collision-avoidance
 *  + pixel-measured plot pattern as Branch Sales / Branch Profitability / Stock Health / Supplier
 *  Performance's matrices (see `resolveBubbleCollisions`'s doc comment). */
export function CashierThroughputMatrix({ points, formatValue, colorFor, onBubbleClick, activeId }: Props) {
  // `setPlotEl` (state, not a plain ref) so the ResizeObserver attaches correctly even when the
  // plot div mounts after an initial empty/loading render.
  const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 640, height: 240 });
  useEffect(() => {
    if (!plotEl) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(plotEl);
    return () => ro.disconnect();
  }, [plotEl]);

  if (points.length === 0) {
    return <p className={css.emptyNote}>No cashier activity in this range yet.</p>;
  }

  const maxTransactions = Math.max(...points.map((p) => p.transactions), 1);
  const maxAvgBasket = Math.max(...points.map((p) => p.avgBasket), 1);
  const maxRevenue = Math.max(...points.map((p) => p.revenue), 1);
  const medianTransactions = median(points.map((p) => p.transactions));
  const medianAvgBasket = median(points.map((p) => p.avgBasket));

  const xOf = (transactions: number) => Math.min(100, (Math.max(0, transactions) / maxTransactions) * 100);
  // CSS `top%` directly — higher avg. basket sits higher up (smaller top%), same convention every
  // other matrix on this page uses for its Y axis.
  const topOf = (avgBasket: number) => 100 - Math.min(100, Math.max(0, (avgBasket / maxAvgBasket) * 100));
  const sizeOf = (revenue: number) => 10 + Math.sqrt(Math.max(0, revenue) / maxRevenue) * 24;

  const padW = Math.max(1, size.width - EDGE_PAD * 2);
  const padH = Math.max(1, size.height - EDGE_PAD * 2);
  const resolved = resolveBubbleCollisions(
    points.map((p) => ({ id: p.id, x: (xOf(p.transactions) / 100) * padW, y: (topOf(p.avgBasket) / 100) * padH, r: sizeOf(p.revenue) / 2 })),
    padW,
    padH,
  );
  const posById = new Map(resolved.map((r) => [r.id, { x: r.x + EDGE_PAD, y: r.y + EDGE_PAD }]));

  const xRefPct = xOf(medianTransactions);
  const yRefTopPct = topOf(medianAvgBasket);

  return (
    <div className={css.healthMatrixWrap}>
      <div className={css.healthMatrixLegendRow}>
        {points.map((p) => (
          <span key={p.id} className={css.benchmarkLegendItem}>
            <i className={css.benchmarkDotSwatch} style={{ background: colorFor(p.id) }} /> {p.label}
          </span>
        ))}
      </div>
      <div className={css.healthMatrixBody}>
        <div className={css.healthMatrixAxisY}>
          <span className={css.healthMatrixAxisEnd}>High</span>
          <span className={css.healthMatrixAxisYTitle}>Avg. Basket Value</span>
          <span className={css.healthMatrixAxisEnd}>Low</span>
        </div>
        <div className={css.healthMatrixPlotCol}>
          <div className={css.healthMatrixPlot} ref={setPlotEl}>
            <div className={css.healthMatrixGridlineY} style={{ left: `${xRefPct}%` }} />
            <div className={css.healthMatrixGridlineX} style={{ top: `${yRefTopPct}%` }} />
            {points.map((p) => {
              const pos = posById.get(p.id)!;
              const left = (pos.x / size.width) * 100;
              const top = (pos.y / size.height) * 100;
              const bubbleSize = sizeOf(p.revenue);
              const tooltip = `${p.label} — ${p.transactions.toLocaleString("en-IN")} transactions, ${formatValue(p.avgBasket)} avg. basket, ${formatValue(p.revenue)} revenue`;
              return (
                <div
                  key={p.id}
                  role={onBubbleClick ? "button" : undefined}
                  tabIndex={onBubbleClick ? 0 : undefined}
                  className={`${css.healthMatrixBubble}${onBubbleClick ? ` ${css.healthMatrixBubbleClickable}` : ""}${activeId === p.id ? ` ${css.healthMatrixBubbleActive}` : ""}`}
                  style={{ left: `${left}%`, top: `${top}%`, width: bubbleSize, height: bubbleSize, background: colorFor(p.id) }}
                  data-tooltip={tooltip}
                  onClick={onBubbleClick ? () => onBubbleClick(p.id) : undefined}
                />
              );
            })}
          </div>
          <div className={css.healthMatrixAxisX}>
            <span className={css.healthMatrixAxisEnd}>Low</span>
            <span className={css.healthMatrixAxisXTitle}>Transactions</span>
            <span className={css.healthMatrixAxisEnd}>High</span>
          </div>
        </div>
      </div>
    </div>
  );
}
