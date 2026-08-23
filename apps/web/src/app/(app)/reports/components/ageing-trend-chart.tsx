"use client";

import { useState } from "react";
import type { AgeBucketKey } from "../lib/types";
import { AGE_BUCKET_COLORS } from "./ageing-profile-chart";
import css from "../reports.module.css";

export type AgeingTrendBucket = { key: AgeBucketKey; label: string; value: number; pct: number };
export type AgeingTrendPoint = { key: string; label: string; totalValue: number; buckets: AgeingTrendBucket[] };

type Props = {
  points: AgeingTrendPoint[];
  formatValue: (n: number) => string;
  height?: number;
};

const GRID_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

/** 100%-stacked column per month — every bar is the same height (each month's full inventory,
 *  normalized to 100%), so the Y-axis is a plain 0–100% scale, not LKR. Fixed height +
 *  preserveAspectRatio="none" (same technique as TrendChart/ExpiryTimeBucketChart). */
export function AgeingTrendChart({ points, formatValue, height = 260 }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  if (points.length === 0 || points.every((p) => p.totalValue <= 0)) {
    return <p className={css.emptyNote}>No stock history in this range yet.</p>;
  }

  const VB_W = 640;
  const padL = 4;
  const padR = 4;
  const padT = 26;
  const padB = 6;
  const plotW = VB_W - padL - padR;
  const plotH = height - padT - padB;
  const n = points.length;
  const slot = plotW / n;
  const barW = Math.min(slot * 0.55, 90);

  const yFor = (pct: number) => padT + plotH - (pct / 100) * plotH;
  const cxFor = (i: number) => padL + slot * i + slot / 2;

  const hoverIdx = hoverKey != null ? points.findIndex((p) => p.key === hoverKey) : -1;
  const hovered = hoverIdx >= 0 ? points[hoverIdx]! : null;
  const hoveredRows = hovered ? hovered.buckets.filter((b) => b.value > 0) : [];
  const TOOLTIP_GAP_VB = 14;
  const isNearRightEdge = hoverIdx >= n - 2;

  return (
    <div className={css.chartWrap}>
      <div className={css.chartPlotWithY}>
        <div className={css.chartYAxis} style={{ height }}>
          {GRID_FRACTIONS.map((f) => (
            <span key={f} className={css.chartYLabel} style={{ top: `${((padT + plotH - f * plotH) / height) * 100}%` }}>
              {Math.round(f * 100)}%
            </span>
          ))}
        </div>
        <div className={css.chartPlot}>
          <svg viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }}>
            {GRID_FRACTIONS.map((f) => {
              const gy = padT + plotH - f * plotH;
              return <line key={f} x1={padL} x2={VB_W - padR} y1={gy} y2={gy} className={css.gridline} />;
            })}
            {points.map((p, i) => {
              const cx = cxFor(i);
              let cursor = 0;
              const isDimmed = hoverKey != null && hoverKey !== p.key;
              return (
                <g key={p.key} onMouseEnter={() => setHoverKey(p.key)} onMouseLeave={() => setHoverKey(null)} style={{ cursor: "pointer" }}>
                  {p.buckets.map((b) => {
                    const y1 = yFor(cursor);
                    cursor += b.pct;
                    const y2 = yFor(cursor);
                    return (
                      <rect
                        key={b.key}
                        x={cx - barW / 2}
                        y={y2}
                        width={barW}
                        height={Math.max(0, y1 - y2)}
                        fill={AGE_BUCKET_COLORS[b.key]}
                        opacity={isDimmed ? 0.35 : 1}
                        style={{ transition: "opacity 0.15s ease" }}
                      />
                    );
                  })}
                  <text x={cx} y={padT - 8} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
                    {formatValue(p.totalValue)}
                  </text>
                </g>
              );
            })}
          </svg>
          {hovered ? (
            <div
              className={css.chartTooltip}
              style={{
                opacity: 1,
                // Beside the bar, not centered over it — centering collided with the total-value
                // label already sitting above the bar. Flips to the bar's left near the chart's
                // right edge so the tooltip never runs off the card.
                left: `${((isNearRightEdge ? cxFor(hoverIdx) - barW / 2 - TOOLTIP_GAP_VB : cxFor(hoverIdx) + barW / 2 + TOOLTIP_GAP_VB) / VB_W) * 100}%`,
                top: "50%",
                transform: isNearRightEdge ? "translate(-100%, -50%)" : "translate(0, -50%)",
              }}
            >
              <span className={css.chartTooltipLabel}>{hovered.label}</span>
              <span className={css.chartTooltipValue}>Total: {formatValue(hovered.totalValue)}</span>
              {hoveredRows.map((b) => (
                <span key={b.key} className={css.chartTooltipRow}>
                  <span className={css.chartTooltipRowLabel}>
                    <i className={css.legendDot} style={{ background: AGE_BUCKET_COLORS[b.key] }} aria-hidden />
                    {b.label}
                  </span>
                  <span className={css.chartTooltipRowValue}>
                    {formatValue(b.value)} ({b.pct.toFixed(0)}%)
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className={css.chartLabels}>
        {points.map((p) => (
          <span key={p.key}>{p.label}</span>
        ))}
      </div>
      <div className={css.chartLegend}>
        {points[0]!.buckets.map((b) => (
          <span key={b.key}>
            <i className={css.legendSwatch} style={{ background: AGE_BUCKET_COLORS[b.key] }} />
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}
