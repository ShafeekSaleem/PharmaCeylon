"use client";

import { useEffect, useState } from "react";
import { resolveBubbleCollisions } from "../lib/bubble-layout";
import css from "../reports.module.css";

export type SupplierMatrixPoint = {
  supplierId: string;
  supplierName: string;
  spend: number;
  onTimePct: number | null;
  priceVariancePct: number | null;
  grade: "preferred" | "good" | "monitor" | "review";
};

type Props = {
  points: SupplierMatrixPoint[];
  formatValue: (n: number) => string;
};

const GRADE_COLOR: Record<SupplierMatrixPoint["grade"], string> = {
  preferred: "#16a34a",
  good: "#0284c7",
  monitor: "#ea580c",
  review: "#dc2626",
};
const GRADE_LABEL: Record<SupplierMatrixPoint["grade"], string> = {
  preferred: "Preferred",
  good: "Good",
  monitor: "Monitor",
  review: "Review",
};

/** X = delivery reliability (on-time %), Y = price competitiveness (100 − |price variance| × 5,
 *  so a supplier dead-on the agreed price sits at the top and one running hot or cold on price
 *  both drift down) — bubble size = spend. A supplier with no on-time-eligible orders yet plots at
 *  a neutral midpoint on that axis rather than being dropped, since it still has real spend/price
 *  data worth showing; the scorecard table is where the "no data yet" nuance is explicit.
 *  Overlapping/tied bubbles (small supplier counts frequently tie on rounded on-time%/price-variance
 *  — e.g. two suppliers both at 100%/0%) are fanned apart by `resolveBubbleCollisions` in real pixel
 *  space, so a tied bubble never sits exactly on top of another and becomes unhoverable. */
export function SupplierPerformanceMatrix({ points, formatValue }: Props) {
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
    return <p className={css.emptyNote}>No supplier deliveries in this range yet.</p>;
  }

  const maxSpend = Math.max(...points.map((p) => p.spend), 1);
  const xOf = (p: SupplierMatrixPoint) => p.onTimePct ?? 50;
  const yOf = (p: SupplierMatrixPoint) => (p.priceVariancePct == null ? 50 : Math.max(0, 100 - Math.abs(p.priceVariancePct) * 5));
  const sizeOf = (spend: number) => 12 + Math.sqrt(spend / maxSpend) * 28;

  const resolved = resolveBubbleCollisions(
    points.map((p) => ({ id: p.supplierId, x: (xOf(p) / 100) * size.width, y: (1 - yOf(p) / 100) * size.height, r: sizeOf(p.spend) / 2 })),
    size.width,
    size.height,
  );
  const posById = new Map(resolved.map((r) => [r.id, r]));
  const positioned = points.map((p) => {
    const pos = posById.get(p.supplierId)!;
    return { p, left: (pos.x / size.width) * 100, top: (pos.y / size.height) * 100 };
  });

  return (
    <div className={css.healthMatrixWrap}>
      <div className={css.perfMatrixLegendRow}>
        {(Object.keys(GRADE_LABEL) as SupplierMatrixPoint["grade"][]).map((g) => (
          <span key={g} className={css.benchmarkLegendItem}>
            <i className={css.benchmarkDotSwatch} style={{ background: GRADE_COLOR[g] }} /> {GRADE_LABEL[g]}
          </span>
        ))}
      </div>
      <div className={css.healthMatrixBody}>
        <div className={css.healthMatrixAxisY}>
          <span className={css.healthMatrixAxisEnd}>High</span>
          <span className={css.healthMatrixAxisYTitle}>Price Competitiveness</span>
          <span className={css.healthMatrixAxisEnd}>Low</span>
        </div>
        <div className={css.healthMatrixPlotCol}>
          <div className={css.healthMatrixPlot} ref={setPlotEl}>
            <div className={css.healthMatrixGridlineY} style={{ left: "50%" }} />
            <div className={css.healthMatrixGridlineX} style={{ top: "50%" }} />
            {positioned.map(({ p, left, top }) => {
              const bubbleSize = sizeOf(p.spend);
              const tooltip = `${p.supplierName} — ${formatValue(p.spend)} spend, ${p.onTimePct == null ? "no on-time data" : `${p.onTimePct.toFixed(0)}% on-time`}, ${p.priceVariancePct == null ? "no price data" : `${p.priceVariancePct >= 0 ? "+" : ""}${p.priceVariancePct.toFixed(1)}% price variance`} — ${GRADE_LABEL[p.grade]}`;
              return (
                <div
                  key={p.supplierId}
                  className={css.healthMatrixBubble}
                  style={{ left: `${left}%`, top: `${top}%`, width: bubbleSize, height: bubbleSize, background: GRADE_COLOR[p.grade] }}
                  data-tooltip={tooltip}
                />
              );
            })}
          </div>
          <div className={css.healthMatrixAxisX}>
            <span className={css.healthMatrixAxisEnd}>Low</span>
            <span className={css.healthMatrixAxisXTitle}>Delivery Reliability</span>
            <span className={css.healthMatrixAxisEnd}>High</span>
          </div>
        </div>
      </div>
    </div>
  );
}
