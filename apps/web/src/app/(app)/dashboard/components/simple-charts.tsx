"use client";

import { useId, useState } from "react";
import css from "../dashboard.module.css";

export type ChartPoint = { label: string; value: number };
export type SeriesPoint = { label: string; a: number; b?: number };

type LineChartProps = {
  points: ChartPoint[];
  height?: number;
  color?: string;
  secondaryPoints?: ChartPoint[];
  secondaryColor?: string;
  formatValue?: (n: number) => string;
  aLabel?: string;
  bLabel?: string;
  showYAxis?: boolean;
  dense?: boolean;
  /** Cap visible X labels (sparse ticks); all points stay plotted/hoverable. */
  maxXLabels?: number;
};

/** Evenly spaced indices including first/last for sparse axis labels. */
function sparseLabelIndices(len: number, maxLabels: number): Set<number> {
  if (len <= 0) return new Set();
  if (len <= maxLabels) return new Set(Array.from({ length: len }, (_, i) => i));
  const indices = new Set<number>();
  for (let k = 0; k < maxLabels; k++) {
    indices.add(Math.round((k * (len - 1)) / (maxLabels - 1)));
  }
  return indices;
}

type PathPoint = { x: number; y: number };

/** Catmull-Rom spline → cubic Bezier SVG path through all points. */
function smoothPathThroughPoints(pts: PathPoint[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) {
    return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  }
  if (pts.length === 2) {
    return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)} L ${pts[1]!.x.toFixed(1)} ${pts[1]!.y.toFixed(1)}`;
  }

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

export function SimpleLineChart({
  points,
  height = 160,
  color = "var(--pc-primary)",
  secondaryPoints,
  secondaryColor = "var(--pc-secondary-cyan)",
  formatValue = (n) => String(Math.round(n)),
  aLabel,
  bLabel,
  showYAxis = false,
  dense = false,
  maxXLabels,
}: LineChartProps) {
  const gradId = useId();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (points.length === 0) {
    return <p className={css.emptyState}>No chart data yet.</p>;
  }

  const allValues = [
    ...points.map((p) => p.value),
    ...(secondaryPoints?.map((p) => p.value) ?? []),
  ];
  const rawMax = Math.max(...allValues, 1);
  /** Headroom so peaks don’t clip the top of the plot */
  const max = rawMax * 1.2;
  /** Left pad is plot inset only — Y labels render as HTML so they aren’t stretched */
  const padL = dense ? 8 : showYAxis ? 12 : 28;
  const padR = dense ? 8 : 16;
  const padTop = dense ? 8 : 16;
  const padBottom = dense ? 6 : 16;
  const w = 520;
  const h = height;
  const innerW = w - padL - padR;
  const innerH = h - padTop - padBottom;

  const toCoords = (pts: ChartPoint[]) =>
    pts.map((p, i) => {
      const x = padL + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
      const y = padTop + innerH - (p.value / max) * innerH;
      return { x, y, ...p };
    });

  const coords = toCoords(points);
  const path = smoothPathThroughPoints(coords);
  const area = `${path} L ${coords[coords.length - 1]!.x.toFixed(1)} ${(padTop + innerH).toFixed(1)} L ${coords[0]!.x.toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`;

  const secondaryCoords = secondaryPoints?.length ? toCoords(secondaryPoints) : null;
  const secondaryPath = secondaryCoords ? smoothPathThroughPoints(secondaryCoords) : null;

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const active = hoverIdx != null ? coords[hoverIdx] : null;
  const tipLeftPct = active ? (active.x / w) * 100 : 0;
  const tipTopPct = active ? (active.y / h) * 100 : 0;
  const xLabelCap =
    maxXLabels ??
    (points.length > 14 ? 6 : points.length > 10 ? 7 : points.length);
  const visibleXLabels = sparseLabelIndices(points.length, xLabelCap);

  return (
    <div
      className={`${css.chartWrap} ${dense ? css.chartWrapDense : ""} ${css.chartWrapInteractive}`}
      onMouseLeave={() => setHoverIdx(null)}
    >
      {aLabel && !secondaryPoints ? (
        <div className={`${css.chartLegend} ${css.chartLegendCenter}`}>
          <span>
            <i style={{ background: color }} /> {aLabel}
          </span>
        </div>
      ) : null}
      <div className={showYAxis ? css.chartPlotWithY : css.chartPlotStack}>
        {showYAxis ? (
          <div
            className={`${css.chartYAxis} ${dense ? css.chartYAxisDense : ""}`}
            aria-hidden
          >
            {yTicks.map((t) => {
              const yPct = ((padTop + innerH * (1 - t)) / h) * 100;
              return (
                <span
                  key={t}
                  className={`${css.chartYLabel} ${dense ? css.chartYLabelDense : ""}`}
                  style={{ top: `${yPct}%` }}
                >
                  {formatCompactAxis(max * t)}
                </span>
              );
            })}
          </div>
        ) : null}
        <div className={css.chartPlot}>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            className={css.chartSvg}
            role="img"
            aria-label="Line chart"
            preserveAspectRatio={dense ? "none" : "xMidYMid meet"}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {yTicks.map((t) => {
              const y = padTop + innerH * (1 - t);
              return (
                <line
                  key={t}
                  x1={padL}
                  x2={w - padR}
                  y1={y}
                  y2={y}
                  className={css.chartGrid}
                />
              );
            })}
            <path d={area} fill={`url(#${gradId})`} />
            <path d={path} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {secondaryPath ? (
              <path
                d={secondaryPath}
                fill="none"
                stroke={secondaryColor}
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity="0.9"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}

            {coords.map((c, i) => {
              const left = i === 0 ? padL : (coords[i - 1]!.x + c.x) / 2;
              const right =
                i === coords.length - 1 ? w - padR : (c.x + coords[i + 1]!.x) / 2;
              return (
                <rect
                  key={`hit-${c.label}-${i}`}
                  x={left}
                  y={padTop}
                  width={Math.max(1, right - left)}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(i)}
                />
              );
            })}

            {active ? (
              <g pointerEvents="none">
                <line
                  x1={active.x}
                  x2={active.x}
                  y1={padTop}
                  y2={padTop + innerH}
                  className={css.chartHoverGuide}
                />
              </g>
            ) : null}

            {coords.map((c, i) => (
              <circle
                key={`${c.label}-${i}`}
                cx={c.x}
                cy={c.y}
                r="2.75"
                fill={color}
                opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.35}
                onMouseEnter={() => setHoverIdx(i)}
                style={{ cursor: "pointer" }}
              />
            ))}
            {secondaryCoords?.map((c, i) => (
              <circle
                key={`b-${c.label}-${i}`}
                cx={c.x}
                cy={c.y}
                r="2.5"
                fill={secondaryColor}
              />
            ))}
          </svg>
          {active ? (
            <div
              className={css.chartTooltip}
              style={{
                left: `${tipLeftPct}%`,
                top: `${tipTopPct}%`,
              }}
              role="tooltip"
            >
              <span className={css.chartTooltipLabel}>{active.label}</span>
              <span className={css.chartTooltipValue}>{formatValue(active.value)}</span>
            </div>
          ) : null}
        </div>
        <div
          className={css.chartLabels}
          style={{
            paddingLeft: `${(padL / w) * 100}%`,
            paddingRight: `${(padR / w) * 100}%`,
          }}
        >
          {points.map((p, i) => (
            <span
              key={`${p.label}-${i}`}
              title={`${p.label}: ${formatValue(p.value)}`}
              className={hoverIdx === i ? css.chartLabelActive : undefined}
              aria-hidden={!visibleXLabels.has(i)}
            >
              {visibleXLabels.has(i) ? p.label : ""}
            </span>
          ))}
        </div>
      </div>
      {(aLabel || bLabel) && secondaryPoints ? (
        <div className={css.chartLegend}>
          {aLabel ? (
            <span>
              <i style={{ background: color }} /> {aLabel}
            </span>
          ) : null}
          {bLabel ? (
            <span>
              <i style={{ background: secondaryColor }} /> {bLabel}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatCompactAxis(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

type SparklineProps = {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
};

export function MiniSparkline({
  values,
  color = "var(--pc-primary)",
  width = 72,
  height = 28,
}: SparklineProps) {
  if (values.length < 2) {
    return <span className={css.sparkEmpty} aria-hidden />;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={css.sparkline}
      aria-hidden
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

type BarChartProps = {
  points: ChartPoint[];
  height?: number;
  color?: string;
};

export function SimpleBarChart({
  points,
  height = 160,
  color = "var(--pc-primary)",
}: BarChartProps) {
  if (points.length === 0) {
    return <p className={css.emptyState}>No chart data yet.</p>;
  }
  const max = Math.max(...points.map((p) => p.value), 1);

  return (
    <div className={css.barChart} style={{ height }}>
      {points.map((p, i) => (
        <div key={`${p.label}-${i}`} className={css.barCol}>
          <div className={css.barTrack}>
            <div
              className={css.bar}
              style={{ height: `${Math.max(4, (p.value / max) * 100)}%`, background: color }}
              title={`${p.label}: ${p.value}`}
            />
          </div>
          <span className={css.barLabel}>{p.label}</span>
        </div>
      ))}
    </div>
  );
}

type GroupedBarProps = {
  points: SeriesPoint[];
  aLabel: string;
  bLabel: string;
  height?: number;
};

export function SimpleGroupedBarChart({
  points,
  aLabel,
  bLabel,
  height = 160,
}: GroupedBarProps) {
  const [hover, setHover] = useState<{ group: number; series: "a" | "b" } | null>(
    null,
  );

  if (points.length === 0) {
    return <p className={css.emptyState}>No chart data yet.</p>;
  }

  const rawMax = Math.max(...points.flatMap((p) => [p.a, p.b ?? 0]), 1);
  const max = rawMax * 1.08;
  const w = 420;
  const h = Math.max(height, 168);
  /** Plot inset only — Y labels are HTML so stretch does not distort text */
  const padL = 8;
  const padR = 8;
  const padTop = 8;
  /** X labels render outside the SVG so the plot can stretch without distorting text */
  const padBottom = 6;
  const innerW = w - padL - padR;
  const innerH = h - padTop - padBottom;
  const groupCount = points.length;
  const groupSlot = innerW / groupCount;
  /** Fill most of each week column; leave a small inter-week gap */
  const pairWidth = Math.min(groupSlot * 0.72, 78);
  const barGap = 4;
  const barW = (pairWidth - barGap) / 2;
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  const activePoint = hover ? points[hover.group] : null;
  const activeValue =
    hover && activePoint
      ? hover.series === "a"
        ? activePoint.a
        : (activePoint.b ?? 0)
      : null;
  const activeSeriesLabel = hover ? (hover.series === "a" ? aLabel : bLabel) : null;

  let tipLeftPct = 0;
  let tipTopPct = 0;
  if (hover && activePoint) {
    const slotCenter = padL + groupSlot * hover.group + groupSlot / 2;
    const pairLeft = slotCenter - pairWidth / 2;
    const barH = Math.max(
      4,
      ((hover.series === "a" ? activePoint.a : (activePoint.b ?? 0)) / max) * innerH,
    );
    const baseY = padTop + innerH;
    const barX =
      hover.series === "a" ? pairLeft : pairLeft + barW + barGap;
    tipLeftPct = ((barX + barW / 2) / w) * 100;
    tipTopPct = ((baseY - barH) / h) * 100;
  }

  return (
    <div
      className={`${css.groupedBarWrap} ${css.chartWrapInteractive}`}
      onMouseLeave={() => setHover(null)}
    >
      <div className={`${css.chartLegend} ${css.chartLegendCenter}`}>
        <span>
          <i className={css.chartLegendSwatch_primary} /> {aLabel}
        </span>
        <span>
          <i className={css.chartLegendSwatch_secondary} /> {bLabel}
        </span>
      </div>
      <div className={css.chartPlotWithY}>
        <div className={`${css.chartYAxis} ${css.chartYAxisDense}`} aria-hidden>
          {yTicks.map((t) => {
            const yPct = ((padTop + innerH * (1 - t)) / h) * 100;
            return (
              <span
                key={t}
                className={`${css.chartYLabel} ${css.chartYLabelDense}`}
                style={{ top: `${yPct}%` }}
              >
                {formatCompactAxis(max * t)}
              </span>
            );
          })}
        </div>
        <div className={css.chartPlot}>
          <svg
            viewBox={`0 0 ${w} ${h}`}
            className={css.groupedBarSvg}
            role="img"
            aria-label="Grouped bar chart"
            preserveAspectRatio="none"
          >
            {yTicks.map((t) => {
              const y = padTop + innerH * (1 - t);
              return (
                <line
                  key={t}
                  x1={padL}
                  x2={w - padR}
                  y1={y}
                  y2={y}
                  className={css.chartGrid}
                />
              );
            })}
            {points.map((p, i) => {
              const slotCenter = padL + groupSlot * i + groupSlot / 2;
              const pairLeft = slotCenter - pairWidth / 2;
              const aH = Math.max(4, (p.a / max) * innerH);
              const bH = Math.max(4, ((p.b ?? 0) / max) * innerH);
              const baseY = padTop + innerH;
              const aActive = hover?.group === i && hover.series === "a";
              const bActive = hover?.group === i && hover.series === "b";
              const anyHover = hover != null;
              return (
                <g key={`${p.label}-${i}`}>
                  <rect
                    x={pairLeft}
                    y={baseY - aH}
                    width={barW}
                    height={aH}
                    rx={3}
                    className={css.svgBarPrimary}
                    opacity={anyHover && !aActive ? 0.35 : 1}
                    transform={
                      aActive
                        ? `translate(${pairLeft + barW / 2} ${baseY}) scale(1.06, 1.03) translate(${-(pairLeft + barW / 2)} ${-baseY})`
                        : undefined
                    }
                    style={{ cursor: "pointer", transition: "opacity 0.15s ease" }}
                    onMouseEnter={() => setHover({ group: i, series: "a" })}
                    role="listitem"
                    aria-label={`${aLabel} ${p.label}: ${Math.round(p.a)}`}
                  />
                  <rect
                    x={pairLeft + barW + barGap}
                    y={baseY - bH}
                    width={barW}
                    height={bH}
                    rx={3}
                    className={css.svgBarSecondary}
                    opacity={anyHover && !bActive ? 0.35 : 1}
                    transform={
                      bActive
                        ? `translate(${pairLeft + barW + barGap + barW / 2} ${baseY}) scale(1.06, 1.03) translate(${-(pairLeft + barW + barGap + barW / 2)} ${-baseY})`
                        : undefined
                    }
                    style={{ cursor: "pointer", transition: "opacity 0.15s ease" }}
                    onMouseEnter={() => setHover({ group: i, series: "b" })}
                    role="listitem"
                    aria-label={`${bLabel} ${p.label}: ${Math.round(p.b ?? 0)}`}
                  />
                </g>
              );
            })}
          </svg>
          {hover && activeSeriesLabel != null && activeValue != null && activePoint ? (
            <div
              className={css.chartTooltip}
              style={{
                left: `${tipLeftPct}%`,
                top: `${tipTopPct}%`,
              }}
              role="tooltip"
            >
              <span className={css.chartTooltipLabel}>
                {activePoint.label} · {activeSeriesLabel}
              </span>
              <span className={css.chartTooltipValue}>{Math.round(activeValue).toLocaleString()}</span>
            </div>
          ) : null}
        </div>
        <div
          className={css.chartLabels}
          style={{
            paddingLeft: `${(padL / w) * 100}%`,
            paddingRight: `${(padR / w) * 100}%`,
          }}
        >
          {points.map((p, i) => (
            <span key={`${p.label}-${i}`} title={p.label}>
              {p.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

type DonutProps = {
  slices: Array<{ label: string; value: number; color: string }>;
  centerLabel?: string;
  centerValue?: string;
  /** Place legend beside the pie (Cash Flow). */
  legendBeside?: boolean;
};

function donutArcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const polar = (r: number, angle: number) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };
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

export function SimpleDonutChart({
  slices,
  centerLabel,
  centerValue,
  legendBeside = true,
}: DonutProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (slices.length === 0) {
    return <p className={css.emptyState}>No payment mix data yet.</p>;
  }

  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const cx = 60;
  const cy = 60;
  const rOuter = 52;
  const rInner = 34;
  const gapDeg = slices.length > 1 ? 2.2 : 0;

  let angle = 0;
  const segments = slices.map((slice, index) => {
    const pct = (slice.value / total) * 100;
    const rawSweep = (slice.value / total) * 360;
    const sweep = Math.min(
      359.99,
      Math.max(0.8, rawSweep - (slices.length > 1 ? gapDeg : 0)),
    );
    const start = angle + (slices.length > 1 ? gapDeg / 2 : 0);
    const end = start + sweep;
    angle += rawSweep;
    return { ...slice, index, pct, start, end, fullRing: rawSweep >= 359.5 };
  });

  const active = hovered != null ? segments[hovered] : null;
  const displayValue = active
    ? `${active.pct.toFixed(1)}%`
    : centerValue;
  const displayLabel = active ? active.label : centerLabel;

  return (
    <div className={legendBeside ? css.donutWrapModern : css.donutWrap}>
      <div
        className={css.donutChartCol}
        onMouseLeave={() => setHovered(null)}
      >
        <svg viewBox="0 0 120 120" className={css.donutSvg} role="img" aria-label="Payment mix">
          <circle cx={cx} cy={cy} r={rOuter + 2} className={css.donutHalo} />
          {segments.map((seg) => {
            const isActive = hovered === seg.index;
            const dimmed = hovered != null && !isActive;
            const ro = isActive ? rOuter + 2.5 : rOuter;
            const ri = isActive ? rInner - 1 : rInner;
            if (seg.fullRing) {
              return (
                <circle
                  key={seg.label}
                  cx={cx}
                  cy={cy}
                  r={(ro + ri) / 2}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={ro - ri}
                  className={css.donutSegment}
                  opacity={dimmed ? 0.35 : 1}
                  onMouseEnter={() => setHovered(seg.index)}
                  onFocus={() => setHovered(seg.index)}
                  tabIndex={0}
                  role="listitem"
                  aria-label={`${seg.label}: ${seg.pct.toFixed(1)} percent`}
                />
              );
            }
            return (
              <path
                key={seg.label}
                d={donutArcPath(cx, cy, ro, ri, seg.start, seg.end)}
                fill={seg.color}
                className={css.donutSegment}
                opacity={dimmed ? 0.35 : 1}
                onMouseEnter={() => setHovered(seg.index)}
                onFocus={() => setHovered(seg.index)}
                tabIndex={0}
                role="listitem"
                aria-label={`${seg.label}: ${seg.pct.toFixed(1)} percent`}
              />
            );
          })}
          <circle cx={cx} cy={cy} r={rInner - 0.5} fill="var(--pc-card-bg)" />
        </svg>
        <div className={css.donutCenter}>
          <strong className={active ? css.donutCenterHighlight : undefined}>
            {displayValue}
          </strong>
          <span>{displayLabel}</span>
        </div>
      </div>
      <ul className={css.donutLegendModern}>
        {segments.map((seg) => {
          const isActive = hovered === seg.index;
          return (
            <li key={seg.label}>
              <button
                type="button"
                className={`${css.donutLegendBtn} ${isActive ? css.donutLegendBtnActive : ""}`}
                onMouseEnter={() => setHovered(seg.index)}
                onFocus={() => setHovered(seg.index)}
                onMouseLeave={() => setHovered(null)}
                onBlur={() => setHovered(null)}
              >
                <i style={{ background: seg.color }} aria-hidden />
                <span>{seg.label}</span>
                <em>{seg.pct.toFixed(1)}%</em>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
