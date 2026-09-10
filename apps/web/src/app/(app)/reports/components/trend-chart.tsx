"use client";

import { useRef, useState } from "react";
import { formatCompactMoney } from "../lib/format";
import css from "../reports.module.css";

type Point = { label: string; date: string; value: number };
type Coord = { x: number; y: number };

type Props = {
  points: Point[];
  previousPoints?: Point[];
  currentLabel?: string;
  previousLabel?: string;
  /** Axis tick formatter — compact by default (10K, 1.2M) so labels never crowd the plot border. */
  formatValue?: (n: number) => string;
  /** Hover tooltip formatter — falls back to `formatValue` when omitted, but callers usually pass a full-precision formatter (e.g. exact currency) since the tooltip has room the axis doesn't. */
  tooltipFormat?: (n: number) => string;
  height?: number;
};

const VB_W = 900;
const GRID_FRACTIONS = [0, 0.33, 0.66, 1];

/** Catmull-Rom spline → cubic Bezier SVG path through all points — same technique the dashboard's
 * `SimpleLineChart` uses, so Reports' trend lines get the same smooth curve instead of sharp angles. */
function smoothPath(pts: Coord[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  if (pts.length === 2) return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)} L ${pts[1]!.x.toFixed(1)} ${pts[1]!.y.toFixed(1)}`;

  let d = `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/** Evenly spaced indices including first/last, so sparse X labels never crowd — same helper the
 * dashboard's charts use. */
function sparseLabelIndices(len: number, maxLabels: number): Set<number> {
  if (len <= 0) return new Set();
  if (len <= maxLabels) return new Set(Array.from({ length: len }, (_, i) => i));
  const indices = new Set<number>();
  for (let k = 0; k < maxLabels; k++) {
    indices.add(Math.round((k * (len - 1)) / (maxLabels - 1)));
  }
  return indices;
}

export function TrendChart({
  points,
  previousPoints,
  currentLabel = "Current period",
  previousLabel = "Previous period",
  formatValue = formatCompactMoney,
  tooltipFormat,
  height = 185,
}: Props) {
  const formatTooltip = tooltipFormat ?? formatValue;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return <p className={css.emptyNote}>No trend data for this range yet.</p>;
  }

  const padL = 4;
  const padR = 4;
  const padT = 10;
  const padB = 4;
  const plotW = VB_W - padL - padR;
  const plotH = height - padT - padB;

  const hasPrevious = !!previousPoints && previousPoints.length > 0;
  const max = Math.max(...points.map((p) => p.value), ...(previousPoints?.map((p) => p.value) ?? []), 1);
  const x = (i: number, len: number) => padL + (len === 1 ? plotW / 2 : (i / (len - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  const coords: Coord[] = points.map((p, i) => ({ x: x(i, points.length), y: y(p.value) }));
  const linePath = smoothPath(coords);
  const areaPath = `${linePath} L ${coords[coords.length - 1]!.x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${coords[0]!.x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  const prevCoords: Coord[] = hasPrevious ? previousPoints!.map((p, i) => ({ x: x(i, previousPoints!.length), y: y(p.value) })) : [];
  const prevPath = hasPrevious ? smoothPath(prevCoords) : "";

  const active = hoverIdx != null ? points[hoverIdx] : null;
  const activePrev = hoverIdx != null && hasPrevious ? previousPoints![hoverIdx] : null;

  const xLabelCap = points.length > 14 ? 7 : points.length > 10 ? 8 : points.length;
  const visibleXLabels = sparseLabelIndices(points.length, xLabelCap);

  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * VB_W;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(((relX - padL) / plotW) * (points.length - 1))));
    setHoverIdx(idx);
  }

  return (
    <div className={css.chartWrap}>
      <div className={css.chartPlotWithY}>
        <div className={css.chartYAxis} style={{ height }}>
          {GRID_FRACTIONS.map((f) => (
            <span key={f} className={css.chartYLabel} style={{ top: `${((padT + plotH - f * plotH) / height) * 100}%` }}>
              {formatValue(f * max)}
            </span>
          ))}
        </div>
        <div className={css.chartPlot} ref={wrapRef}>
          <svg viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }}>
            <defs>
              <linearGradient id="reportsTrendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--pc-primary)" stopOpacity="0.3" />
                <stop offset="100%" stopColor="var(--pc-primary)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {GRID_FRACTIONS.map((f) => {
              const gy = padT + plotH - f * plotH;
              return <line key={f} x1={padL} x2={VB_W - padR} y1={gy} y2={gy} className={css.gridline} />;
            })}
            <path d={areaPath} fill="url(#reportsTrendGrad)" stroke="none" />
            {hasPrevious ? <path d={prevPath} className={css.previousLine} /> : null}
            <path d={linePath} fill="none" stroke="var(--pc-primary)" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" />
            {coords.map((c, i) => (
              <circle
                key={points[i]!.date}
                cx={c.x}
                cy={c.y}
                r={hoverIdx === i ? 4.5 : 3}
                fill="var(--pc-primary)"
                opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.45}
              />
            ))}
            {active ? <line x1={x(hoverIdx!, points.length)} x2={x(hoverIdx!, points.length)} y1={padT} y2={padT + plotH} className={css.crosshair} opacity={1} /> : null}
            <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent" onMouseMove={handleMove} onMouseLeave={() => setHoverIdx(null)} />
          </svg>
          {active ? (
            <div
              className={css.chartTooltip}
              style={{
                opacity: 1,
                left: `${(x(hoverIdx!, points.length) / VB_W) * 100}%`,
                top: `${(y(active.value) / height) * 100}%`,
                transform: "translate(-50%, -130%)",
              }}
            >
              <span className={css.chartTooltipLabel}>{active.label}</span>
              <span className={css.chartTooltipValue}>{formatTooltip(active.value)}</span>
              {activePrev ? <span className={css.chartTooltipMuted}>Prev: {formatTooltip(activePrev.value)}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className={css.chartLabels}>
        {points.map((p, i) => (
          <span key={p.date} className={hoverIdx === i ? css.chartLabelActive : undefined} aria-hidden={!visibleXLabels.has(i)}>
            {visibleXLabels.has(i) ? p.label : ""}
          </span>
        ))}
      </div>
      {hasPrevious ? (
        <div className={css.chartLegend}>
          <span>
            <i className={css.legendSwatch} style={{ background: "var(--pc-primary)" }} />
            {currentLabel}
          </span>
          <span>
            <i className={css.legendSwatch} style={{ background: "var(--pc-muted-fg)", opacity: 0.6 }} />
            {previousLabel}
          </span>
        </div>
      ) : null}
    </div>
  );
}
