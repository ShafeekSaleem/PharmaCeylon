"use client";

import { useState } from "react";
import css from "../reports.module.css";

export type BucketSeriesValue = { id: string; label: string; color: string; value: number };
export type TimeBucket = { key: string; label: string; sublabel: string; series: BucketSeriesValue[] };

type Props = {
  buckets: TimeBucket[];
  formatValue: (n: number) => string;
  height?: number;
};

const GRID_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];
const MAX_TOOLTIP_ROWS = 8;

/** Stacked column chart: one bar per time bucket, segmented by commercial sub-category — value
 *  (LKR at risk), not unit count, so a bucket's height directly reads as exposure. Fixed height +
 *  preserveAspectRatio="none" (same technique as TrendChart) since every label lives in HTML
 *  outside the SVG, so non-uniform width scaling never distorts anything. Hovering a bucket dims
 *  the rest and opens a per-category breakdown tooltip (same tooltip language as TrendChart). */
export function ExpiryTimeBucketChart({ buckets, formatValue, height = 230 }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const totals = buckets.map((b) => b.series.reduce((s, v) => s + v.value, 0));
  const maxTotal = Math.max(...totals, 1) * 1.18;
  if (maxTotal <= 1.18) {
    return <p className={css.emptyNote}>No expiring stock in this range yet.</p>;
  }

  const VB_W = 640;
  const padL = 4;
  const padR = 4;
  const padT = 26;
  const padB = 6;
  const plotW = VB_W - padL - padR;
  const plotH = height - padT - padB;
  const n = buckets.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.5, 96);

  const yFor = (v: number) => padT + plotH - (v / maxTotal) * plotH;
  const cxFor = (i: number) => padL + slot * i + slot / 2;

  const allSeriesIds = Array.from(new Map(buckets.flatMap((b) => b.series.map((s) => [s.id, s] as const))).values());

  const hoverIdx = hoverKey != null ? buckets.findIndex((b) => b.key === hoverKey) : -1;
  const hoveredBucket = hoverIdx >= 0 ? buckets[hoverIdx]! : null;
  const hoveredTotal = hoverIdx >= 0 ? totals[hoverIdx]! : 0;
  const hoveredRows = hoveredBucket ? [...hoveredBucket.series].filter((s) => s.value > 0).sort((a, b) => b.value - a.value) : [];
  const visibleHoveredRows = hoveredRows.slice(0, MAX_TOOLTIP_ROWS);
  const hiddenHoveredCount = hoveredRows.length - visibleHoveredRows.length;

  return (
    <div className={css.chartWrap}>
      <div className={css.chartPlotWithY}>
        <div className={css.chartYAxis} style={{ height }}>
          {GRID_FRACTIONS.map((f) => (
            <span key={f} className={css.chartYLabel} style={{ top: `${((padT + plotH - f * plotH) / height) * 100}%` }}>
              {formatValue(f * maxTotal)}
            </span>
          ))}
        </div>
        <div className={css.chartPlot}>
          <svg viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }}>
            {GRID_FRACTIONS.map((f) => {
              const gy = padT + plotH - f * plotH;
              return <line key={f} x1={padL} x2={VB_W - padR} y1={gy} y2={gy} className={css.gridline} />;
            })}
            {buckets.map((b, i) => {
              const cx = cxFor(i);
              const total = totals[i]!;
              let cursor = 0;
              const isDimmed = hoverKey != null && hoverKey !== b.key;
              return (
                <g key={b.key} onMouseEnter={() => setHoverKey(b.key)} onMouseLeave={() => setHoverKey(null)} style={{ cursor: "pointer" }}>
                  {b.series.map((s) => {
                    const y1 = yFor(cursor);
                    cursor += s.value;
                    const y2 = yFor(cursor);
                    return (
                      <rect
                        key={s.id}
                        x={cx - barW / 2}
                        y={y2}
                        width={barW}
                        height={Math.max(0, y1 - y2)}
                        fill={s.color}
                        opacity={isDimmed ? 0.35 : 1}
                        style={{ transition: "opacity 0.15s ease" }}
                      />
                    );
                  })}
                  <text x={cx} y={yFor(total) - 8} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
                    {formatValue(total)}
                  </text>
                </g>
              );
            })}
          </svg>
          {hoveredBucket ? (
            <div
              className={css.chartTooltip}
              style={{
                opacity: 1,
                left: `${(cxFor(hoverIdx) / VB_W) * 100}%`,
                top: `${(yFor(hoveredTotal) / height) * 100}%`,
                transform: "translate(-50%, -110%)",
              }}
            >
              <span className={css.chartTooltipLabel}>
                {hoveredBucket.label} {hoveredBucket.sublabel}
              </span>
              <span className={css.chartTooltipValue}>Total: {formatValue(hoveredTotal)}</span>
              {visibleHoveredRows.map((s) => (
                <span key={s.id} className={css.chartTooltipRow}>
                  <span className={css.chartTooltipRowLabel}>
                    <i className={css.legendDot} style={{ background: s.color }} aria-hidden />
                    {s.label}
                  </span>
                  <span className={css.chartTooltipRowValue}>{formatValue(s.value)}</span>
                </span>
              ))}
              {hiddenHoveredCount > 0 ? <span className={css.chartTooltipMuted}>+{hiddenHoveredCount} more</span> : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className={css.chartLabels}>
        {buckets.map((b) => (
          <span key={b.key} className={css.expBucketLabel}>
            {b.label}
            <em>{b.sublabel}</em>
          </span>
        ))}
      </div>
      <div className={css.chartLegend}>
        {allSeriesIds.map((s) => (
          <span key={s.id}>
            <i className={css.legendSwatch} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
