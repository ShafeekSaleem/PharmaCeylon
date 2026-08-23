"use client";

import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { ppChange, formatPpTrend } from "../lib/format";
import css from "../reports.module.css";

type Props = {
  actualPct: number;
  targetPct: number | null;
  /** Shown instead of the gauge when `targetPct` is null — no target has been configured yet, so
   *  there's nothing honest to render as "the goal". */
  emptyState: ReactNode;
};

/** Within this many points of the target, treated as "on target" rather than a false-precision
 *  above/below call on what's ultimately a noisy period-to-period number. */
const ON_TARGET_BAND_PP = 0.5;

const CX = 110;
const CY = 108;
const R_OUTER = 94;
const R_INNER = 72;
/** Gauge start (9 o'clock) / end (3 o'clock), sweeping clockwise through the top — same polar
 *  convention as `SimpleDonutChart`'s `donutArcPath` (angle 0 = 12 o'clock), just restricted to a
 *  180° span instead of a full ring. */
const START_ANGLE = 270;
const SWEEP_DEG = 180;

function polar(r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
}

function ringPath(rOuter: number, rInner: number, startAngle: number, endAngle: number): string {
  const large = endAngle - startAngle > 180 ? 1 : 0;
  const so = polar(rOuter, startAngle);
  const eo = polar(rOuter, endAngle);
  const si = polar(rInner, endAngle);
  const ei = polar(rInner, startAngle);
  return [
    `M ${so.x} ${so.y}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${eo.x} ${eo.y}`,
    `L ${si.x} ${si.y}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${ei.x} ${ei.y}`,
    "Z",
  ].join(" ");
}

/** Semicircular actual-vs-target gauge for Profit Summary's "Margin vs Target" card — same visual
 *  language as the original `MarginGauge`, plus a status pill on top. */
export function MarginVsTarget({ actualPct, targetPct, emptyState }: Props) {
  if (targetPct == null) {
    return <div className={css.gaugeEmpty}>{emptyState}</div>;
  }

  const gaugeMax = Math.max(60, Math.ceil((Math.max(actualPct, targetPct) * 1.15) / 5) * 5);
  const actualFraction = Math.min(1, Math.max(0, actualPct / gaugeMax));
  const actualEndAngle = START_ANGLE + SWEEP_DEG * actualFraction;

  const variance = ppChange(actualPct, targetPct);
  const met = actualPct >= targetPct;
  const onTarget = Math.abs(variance) <= ON_TARGET_BAND_PP;
  const status = onTarget ? "On Target" : met ? "Above Target" : "Below Target";
  const statusVariant = onTarget ? "info" : met ? "success" : "warning";

  return (
    <div className={css.gaugeWrap}>
      <div className={css.marginBarStatusRow}>
        <StatusBadge status={status} label={status} variant={statusVariant} />
      </div>
      <div className={css.gaugeSvgWrap}>
        <svg viewBox="0 0 220 130" role="img" aria-label="Gross margin vs target" className={css.gaugeSvg}>
          <path d={ringPath(R_OUTER, R_INNER, START_ANGLE, START_ANGLE + SWEEP_DEG)} className={css.gaugeTrack} />
          <path d={ringPath(R_OUTER, R_INNER, START_ANGLE, actualEndAngle)} fill={met ? "var(--pc-primary)" : "#ea580c"} />
        </svg>
        <div className={css.gaugeCenter}>
          <strong>{actualPct.toFixed(1)}%</strong>
          <span>Actual Margin</span>
        </div>
      </div>
      <div className={css.gaugeFooter}>
        <div>
          <span className={css.gaugeFooterLabel}>Target</span>
          <b>{targetPct.toFixed(1)}%</b>
        </div>
        <div>
          <span className={css.gaugeFooterLabel}>Variance</span>
          <b className={met ? css.deltaUp : css.deltaDown}>{formatPpTrend(variance)}</b>
        </div>
      </div>
    </div>
  );
}
