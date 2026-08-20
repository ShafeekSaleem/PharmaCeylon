"use client";

import { useMemo, useRef, useState } from "react";
import { formatCompactMoney } from "../lib/format";
import css from "../reports.module.css";

export type MultiLineSeries = { key: string; label: string; color: string; values: number[] };

type Coord = { x: number; y: number };

type Props = {
  labels: string[];
  series: MultiLineSeries[];
  /** Axis tick formatter — compact by default (10K, 1.2M) so labels never crowd the plot border. */
  formatValue?: (n: number) => string;
  /** Hover tooltip formatter — falls back to `formatValue` when omitted. */
  tooltipFormat?: (n: number) => string;
  height?: number;
  /** Which series is the permanent focus (full-weight smooth line + area fill + point markers).
   * Falls back to the first series — callers should pass series pre-sorted by rank. */
  focusKey?: string | null;
  /** Fires when the user clicks a legend entry or a line to change the permanent focus. */
  onFocusChange?: (key: string) => void;
  /** Series present in the data but not rendered (already capped by the caller) — shown as a muted legend suffix, e.g. "+3 more". */
  hiddenLabel?: string;
};

const VB_W = 900;
const GRID_FRACTIONS = [0, 0.33, 0.66, 1];

/** Catmull-Rom spline → cubic Bezier SVG path through all points — same technique the dashboard's
 * `MultiLineChart` uses, so the branch/payment trend charts get the same smooth curve. */
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

/** Evenly spaced indices including first/last, so sparse X labels never crowd. */
function sparseLabelIndices(len: number, maxLabels: number): Set<number> {
  if (len <= 0) return new Set();
  if (len <= maxLabels) return new Set(Array.from({ length: len }, (_, i) => i));
  const indices = new Set<number>();
  for (let k = 0; k < maxLabels; k++) {
    indices.add(Math.round((k * (len - 1)) / (maxLabels - 1)));
  }
  return indices;
}

/** Several named series on one axis (Payment Trend by method, Sales Trend by branch). One series is
 * the visual focus — full color/weight, smooth curve, soft area gradient, and per-point markers — the
 * rest stay as thin, muted context lines behind it, matching the dashboard's Branch Sales Trend panel.
 * Hovering a line/legend entry previews focus; clicking makes it permanent. */
export function MultiLineChart({
  labels,
  series,
  formatValue = formatCompactMoney,
  tooltipFormat,
  height = 185,
  focusKey = null,
  onFocusChange,
  hiddenLabel,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const formatTooltip = tooltipFormat ?? formatValue;

  const nonEmpty = useMemo(() => series.filter((s) => s.values.length > 0), [series]);
  const effectiveFocusKey = hoverKey ?? focusKey ?? nonEmpty[0]?.key ?? null;
  const focused = nonEmpty.find((s) => s.key === effectiveFocusKey) ?? nonEmpty[0] ?? null;

  // Computed unconditionally (before the early return below) so hook call order never changes.
  const tooltipDelta = useMemo(() => {
    if (!focused || hoverIdx == null || hoverIdx === 0) return null;
    const prev = focused.values[hoverIdx - 1];
    const cur = focused.values[hoverIdx];
    if (!prev || cur == null) return null;
    const pct = ((cur - prev) / prev) * 100;
    return { pct, positive: pct >= 0 };
  }, [hoverIdx, focused]);

  if (labels.length === 0 || nonEmpty.length === 0 || !focused) {
    return <p className={css.emptyNote}>No trend data for this range yet.</p>;
  }

  const padL = 4, padR = 4, padT = 10, padB = 4;
  const plotW = VB_W - padL - padR;
  const plotH = height - padT - padB;
  const max = Math.max(...nonEmpty.flatMap((s) => s.values), 1);
  const x = (i: number) => padL + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const coordsFor = (s: MultiLineSeries): Coord[] => s.values.map((v, i) => ({ x: x(i), y: y(v) }));

  const focusedCoords = coordsFor(focused);
  const focusedPath = smoothPath(focusedCoords);
  const focusedArea = `${focusedPath} L ${focusedCoords[focusedCoords.length - 1]!.x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${focusedCoords[0]!.x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  const xLabelCap = labels.length > 14 ? 7 : labels.length > 10 ? 8 : labels.length;
  const visibleXLabels = sparseLabelIndices(labels.length, xLabelCap);

  /** Drives both the hovered date column (for the X position) and, by finding the series whose
   * point at that column sits closest to the cursor's Y, which branch's line the tooltip/markers
   * should preview — so hovering shows the branch under the cursor, not always the pinned/top one. */
  function handleMove(e: React.MouseEvent<SVGRectElement>) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * VB_W;
    const idx = Math.max(0, Math.min(labels.length - 1, Math.round(((relX - padL) / plotW) * (labels.length - 1))));
    setHoverIdx(idx);

    const my = ((e.clientY - rect.top) / rect.height) * height;
    let nearestKey: string | null = null;
    let bestDist = 18; // px tolerance in viewBox units
    for (const s of nonEmpty) {
      const py = y(s.values[idx] ?? NaN);
      if (Number.isNaN(py)) continue;
      const dist = Math.abs(py - my);
      if (dist < bestDist) {
        bestDist = dist;
        nearestKey = s.key;
      }
    }
    setHoverKey(nearestKey);
  }

  function handleLeave() {
    setHoverIdx(null);
    setHoverKey(null);
  }

  const tooltipValue = hoverIdx != null ? (focused.values[hoverIdx] ?? null) : null;

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
              <linearGradient id="reportsMultiGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={focused.color} stopOpacity="0.2" />
                <stop offset="55%" stopColor={focused.color} stopOpacity="0.08" />
                <stop offset="100%" stopColor={focused.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {GRID_FRACTIONS.map((f) => {
              const gy = padT + plotH - f * plotH;
              return <line key={f} x1={padL} x2={VB_W - padR} y1={gy} y2={gy} className={css.gridline} />;
            })}
            <path d={focusedArea} fill="url(#reportsMultiGrad)" stroke="none" />
            {nonEmpty
              .filter((s) => s.key !== focused.key)
              .map((s) => (
                <path
                  key={s.key}
                  d={smoothPath(coordsFor(s))}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={1.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.4}
                  vectorEffect="non-scaling-stroke"
                  style={{ cursor: onFocusChange ? "pointer" : undefined }}
                  onClick={() => onFocusChange?.(s.key)}
                />
              ))}
            <path
              d={focusedPath}
              fill="none"
              stroke={focused.color}
              strokeWidth={2.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              style={{ cursor: onFocusChange ? "pointer" : undefined }}
              onClick={() => onFocusChange?.(focused.key)}
            />
            {focusedCoords.map((c, i) => (
              <circle
                key={`marker-${i}`}
                cx={c.x}
                cy={c.y}
                r={hoverIdx === i ? 4 : 2.75}
                fill={focused.color}
                opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.5}
                pointerEvents="none"
              />
            ))}
            {hoverIdx != null ? <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={padT} y2={padT + plotH} className={css.crosshair} opacity={1} /> : null}
            <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent" onMouseMove={handleMove} onMouseLeave={handleLeave} />
          </svg>
          {hoverIdx != null && tooltipValue != null ? (
            <div
              className={css.chartTooltip}
              style={{ opacity: 1, left: `${(x(hoverIdx) / VB_W) * 100}%`, top: `${(padT / height) * 100}%`, transform: "translate(-50%, -8px)" }}
            >
              <span className={css.chartTooltipLabel}>{labels[hoverIdx]}</span>
              <span className={css.chartTooltipValue}>
                <i className={css.legendDot} style={{ background: focused.color }} aria-hidden />
                {focused.label}: <b>{formatTooltip(tooltipValue)}</b>
              </span>
              {tooltipDelta ? (
                <span className={tooltipDelta.positive ? css.deltaUp : css.deltaDown}>
                  {tooltipDelta.positive ? "↑" : "↓"} {Math.abs(tooltipDelta.pct).toFixed(1)}% vs previous
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className={css.chartLabels}>
        {labels.map((label, i) => (
          <span key={label + i} className={hoverIdx === i ? css.chartLabelActive : undefined} aria-hidden={!visibleXLabels.has(i)}>
            {visibleXLabels.has(i) ? label : ""}
          </span>
        ))}
      </div>
      <div className={css.chartLegend}>
        {nonEmpty.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`${css.chartLegendBtn}${s.key === effectiveFocusKey ? ` ${css.chartLegendBtnActive}` : ""}`}
            onMouseEnter={() => setHoverKey(s.key)}
            onMouseLeave={() => setHoverKey(null)}
            onClick={() => onFocusChange?.(s.key)}
            aria-pressed={s.key === effectiveFocusKey}
          >
            <i className={css.legendDot} style={{ background: s.color }} aria-hidden /> {s.label}
          </button>
        ))}
        {hiddenLabel ? <span className={css.chartLegendMore}>{hiddenLabel}</span> : null}
      </div>
    </div>
  );
}
