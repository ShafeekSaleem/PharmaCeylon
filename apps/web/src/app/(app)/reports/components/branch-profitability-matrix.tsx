"use client";

import { useEffect, useState } from "react";
import { resolveBubbleCollisions } from "../lib/bubble-layout";
import css from "../reports.module.css";

export type BranchMatrixQuadrant = "topPerformers" | "marginAttention" | "growthOpportunity" | "review";

export type BranchMatrixPoint = {
  id: string;
  label: string;
  revenue: number;
  marginPct: number;
  grossProfit: number;
  quadrant: BranchMatrixQuadrant;
};

type Props = {
  points: BranchMatrixPoint[];
  formatValue: (n: number) => string;
  /** Vertical reference line — the revenue split (median revenue across branches). */
  revenueReference: number;
  /** Horizontal reference line — the configured (or blended-fallback) margin target. */
  marginReference: number;
  onBubbleClick?: (id: string) => void;
  activeId?: string | null;
};

const QUADRANT_COLOR: Record<BranchMatrixQuadrant, string> = {
  topPerformers: "var(--pc-tone-success)",
  marginAttention: "var(--pc-tone-danger)",
  growthOpportunity: "var(--pc-tone-info)",
  review: "var(--pc-muted-fg)",
};

const QUADRANT_LABEL: Record<BranchMatrixQuadrant, string> = {
  topPerformers: "Top Performers",
  marginAttention: "Margin Attention",
  growthOpportunity: "Growth Opportunity",
  review: "Review",
};

/** Revenue × gross margin quadrant, bubble size = gross profit contribution — "which branches
 *  convert sales into profit most efficiently, and where does scale mask a margin problem".
 *  Same collision-avoidance + pixel-measured plot pattern as the Stock Health / Supplier
 *  Performance matrices (see `resolveBubbleCollisions`'s doc comment) — branch counts are small
 *  enough that every branch is always plotted, no top-N sampling needed. */
export function BranchProfitabilityMatrix({ points, formatValue, revenueReference, marginReference, onBubbleClick, activeId }: Props) {
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
    return <p className={css.emptyNote}>No branch activity in this range yet.</p>;
  }

  const maxRevenue = Math.max(...points.map((p) => p.revenue), revenueReference * 2, 1);
  const maxMarginPct = Math.max(...points.map((p) => p.marginPct), marginReference * 1.15, 10);
  const maxGrossProfit = Math.max(...points.map((p) => p.grossProfit), 1);

  const xOf = (revenue: number) => Math.min(100, (Math.max(0, revenue) / maxRevenue) * 100);
  // CSS `top%` directly — higher margin sits higher up (smaller top%), same convention Stock
  // Health's days-of-cover axis uses.
  const topOf = (marginPct: number) => 100 - Math.min(100, Math.max(0, (marginPct / maxMarginPct) * 100));
  const sizeOf = (grossProfit: number) => 12 + Math.sqrt(Math.max(0, grossProfit) / maxGrossProfit) * 28;
  const clampPct = (v: number) => Math.min(96, Math.max(4, v));

  const xRefPct = clampPct(xOf(revenueReference));
  const yRefTopPct = clampPct(topOf(marginReference));

  // Collision resolution runs in real pixel space (the measured plot size) — see the same
  // technique's doc comment in stock-health-matrix-chart.tsx for why percentages alone aren't
  // comparable across a non-square plot's two axes.
  const resolved = resolveBubbleCollisions(
    points.map((p) => ({ id: p.id, x: (xOf(p.revenue) / 100) * size.width, y: (topOf(p.marginPct) / 100) * size.height, r: sizeOf(p.grossProfit) / 2 })),
    size.width,
    size.height,
  );
  const posById = new Map(resolved.map((r) => [r.id, r]));

  return (
    <div className={css.healthMatrixWrap}>
      <div className={css.healthMatrixLegendRow}>
        {(Object.keys(QUADRANT_LABEL) as BranchMatrixQuadrant[]).map((q) => (
          <span key={q} className={css.benchmarkLegendItem}>
            <i className={css.benchmarkDotSwatch} style={{ background: QUADRANT_COLOR[q] }} /> {QUADRANT_LABEL[q]}
          </span>
        ))}
      </div>
      <div className={css.healthMatrixBody}>
        <div className={css.healthMatrixAxisY}>
          <span className={css.healthMatrixAxisEnd}>High</span>
          <span className={css.healthMatrixAxisYTitle}>Gross Margin %</span>
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
              const bubbleSize = sizeOf(p.grossProfit);
              const tooltip = `${p.label} — ${formatValue(p.revenue)} revenue, ${p.marginPct.toFixed(1)}% margin, ${formatValue(p.grossProfit)} gross profit — ${QUADRANT_LABEL[p.quadrant]}`;
              return (
                <div
                  key={p.id}
                  role={onBubbleClick ? "button" : undefined}
                  tabIndex={onBubbleClick ? 0 : undefined}
                  className={`${css.healthMatrixBubble}${onBubbleClick ? ` ${css.healthMatrixBubbleClickable}` : ""}${activeId === p.id ? ` ${css.healthMatrixBubbleActive}` : ""}`}
                  style={{ left: `${left}%`, top: `${top}%`, width: bubbleSize, height: bubbleSize, background: QUADRANT_COLOR[p.quadrant] }}
                  data-tooltip={tooltip}
                  onClick={onBubbleClick ? () => onBubbleClick(p.id) : undefined}
                />
              );
            })}
          </div>
          <div className={css.healthMatrixAxisX}>
            <span className={css.healthMatrixAxisEnd}>Low</span>
            <span className={css.healthMatrixAxisXTitle}>Revenue</span>
            <span className={css.healthMatrixAxisEnd}>High</span>
          </div>
        </div>
      </div>
    </div>
  );
}
