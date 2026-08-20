"use client";

import css from "../reports.module.css";

export type ScatterPoint = {
  id: string;
  x: number;
  y: number;
  color: string;
  tooltip: string;
};

export type ScatterLegendEntry = { color: string; label: string };

type Props = {
  points: ScatterPoint[];
  /** Horizontal reference line — the selected margin threshold. */
  thresholdY: number;
  thresholdLabel: string;
  formatX: (n: number) => string;
  legend?: ScatterLegendEntry[];
  height?: number;
};

const VB_W = 640;
const padL = 52, padR = 20, padT = 16, padB = 40;

function niceCeil(n: number, step: number): number {
  return Math.max(step, Math.ceil(n / step) * step);
}

/** Plain (non-bubble) scatter — one small dot per SKU, colored by margin band, with a dashed
 *  threshold reference line. Built for point counts in the hundreds, so it deliberately skips
 *  per-point React hover state (CSS `:hover` + the existing `data-tooltip`/`FloatingTooltip`
 *  mechanism handles interactivity without re-rendering on every mouse move). */
export function MarginScatterChart({ points, thresholdY, thresholdLabel, formatX, legend, height = 320 }: Props) {
  if (points.length === 0) {
    return <p className={css.emptyNote}>No products for this range yet.</p>;
  }

  const plotW = VB_W - padL - padR;
  const plotH = height - padT - padB;

  const maxX = Math.max(...points.map((p) => p.x), 1);
  const xMax = niceCeil(maxX * 1.08, 10_000);

  const ys = points.map((p) => p.y);
  const yMax = Math.max(10, Math.ceil((Math.max(...ys, thresholdY, 0) + 5) / 10) * 10);
  const yMin = Math.min(0, Math.floor((Math.min(...ys, 0) - 5) / 10) * 10);

  const x = (v: number) => padL + (v / xMax) * plotW;
  const y = (v: number) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * xMax);
  const yTicks = [1, 0.75, 0.5, 0.25, 0].map((f) => yMin + f * (yMax - yMin));
  const thresholdPx = y(thresholdY);

  return (
    <div className={css.mapWrap}>
      <svg viewBox={`0 0 ${VB_W} ${height}`} className={css.mapSvg} role="img" aria-label="Margin risk distribution" preserveAspectRatio="xMidYMid meet">
        {xTicks.map((t) => (
          <line key={`gx-${t}`} x1={x(t)} x2={x(t)} y1={padT} y2={padT + plotH} className={css.gridline} />
        ))}
        {yTicks.map((t) => (
          <line key={`gy-${t}`} x1={padL} x2={padL + plotW} y1={y(t)} y2={y(t)} className={css.gridline} />
        ))}

        <line x1={padL} x2={padL + plotW} y1={thresholdPx} y2={thresholdPx} stroke="#dc2626" strokeWidth={1.5} strokeDasharray="5 4" />
        <text x={padL + plotW - 4} y={thresholdPx - 5} textAnchor="end" className={css.mapAxisTick} fill="#dc2626">
          {thresholdLabel}
        </text>

        {yTicks.map((t) => (
          <text key={`yl-${t}`} x={padL - 8} y={y(t) + 3} textAnchor="end" className={css.mapAxisTick}>
            {t.toFixed(0)}%
          </text>
        ))}
        <text x={16} y={padT + plotH / 2} textAnchor="middle" className={css.mapAxisTitle} transform={`rotate(-90 16 ${padT + plotH / 2})`}>
          Margin %
        </text>

        {xTicks.map((t) => (
          <text key={`xl-${t}`} x={x(t)} y={padT + plotH + 20} textAnchor="middle" className={css.mapAxisTick}>
            {formatX(t)}
          </text>
        ))}
        <text x={padL + plotW / 2} y={height - 8} textAnchor="middle" className={css.mapAxisTitle}>
          Revenue
        </text>

        {points.map((p) => (
          <circle
            key={p.id}
            cx={x(p.x)}
            cy={y(p.y)}
            r={2.75}
            fill={p.color}
            className={css.scatterDot}
            data-tooltip={p.tooltip}
          />
        ))}
      </svg>

      {legend && legend.length > 0 ? (
        <div className={css.mapLegendRow}>
          <div className={css.mapLegendGroup}>
            <span className={css.mapLegendChips}>
              {legend.map((l) => (
                <span key={l.label} className={css.scatterLegendChip}>
                  <i style={{ background: l.color }} /> {l.label}
                </span>
              ))}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
