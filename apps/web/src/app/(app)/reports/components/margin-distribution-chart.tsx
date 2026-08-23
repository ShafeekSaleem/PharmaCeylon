"use client";

import { useEffect, useId, useRef, useState } from "react";
import css from "../reports.module.css";

export type MarginBand = { key: string; label: string; count: number; revenue: number };

type Props = {
  bands: MarginBand[];
  formatRevenue: (n: number) => string;
  /** Fractional band-index (e.g. 2.5 = halfway through the 3rd band) where the target margin
   *  reference line should sit — the caller interpolates this from the target %, null hides it. */
  targetPosition: number | null;
  targetLabel: string;
  height?: number;
};

/** Grouped dual-axis histogram: how many products fall in each margin band (left axis, solid
 *  bars) and how much revenue they represent (right axis, lighter bars) — replaces a scatter plot
 *  that gets unreadable once hundreds of products overlap at similar margins. */
export function MarginDistributionChart({ bands, formatRevenue, targetPosition, targetLabel, height = 260 }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  // useId()'s raw output (e.g. "«r0»") breaks url(#...) gradient resolution in SVG — strip
  // it down to plain alphanumerics before using it as a DOM id.
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, "");

  // The chart needs a fixed height regardless of how wide its card renders (so it stays level
  // with a sibling card), but a static viewBox width scaled via preserveAspectRatio="meet" ties
  // height to width (taller on a wider card) or letterboxes (gutters when the card exceeds the
  // viewBox's native width). Measuring the real container width and using it as the viewBox
  // width makes 1 SVG unit == 1 CSS px, so width fills the card and height stays exactly fixed,
  // with no distortion of the <text> labels.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(640);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setMeasuredWidth(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the wrapping div (and its ResizeObserver-carrying ref) mounted unconditionally — if it
  // only rendered once real data arrived, the observer (which only attaches once, on first
  // mount) would never fire for a chart that starts in this empty state during initial load.
  const isEmpty = bands.length === 0 || bands.every((b) => b.count === 0);

  // 20% headroom above the tallest bar so the target line's label and per-bar hover
  // tooltips (which render just above the bar top) never collide with the axis ceiling.
  const maxCount = Math.max(...bands.map((b) => b.count), 1) * 1.2;
  const maxRevenue = Math.max(...bands.map((b) => b.revenue), 1) * 1.2;

  const w = measuredWidth;
  const padL = 34;
  const padR = 58;
  const padT = 20;
  const padB = 30;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const n = bands.length || 1;
  const slot = innerW / n;
  const groupW = Math.min(slot * 0.62, 58);
  const barW = groupW / 2 - 3;

  const yForCount = (v: number) => padT + innerH - (v / maxCount) * innerH;
  const yForRevenue = (v: number) => padT + innerH - (v / maxRevenue) * innerH;

  if (isEmpty) {
    return (
      <div className={css.mapWrap} ref={wrapRef}>
        <p className={css.emptyNote}>No product sales in this range yet.</p>
      </div>
    );
  }

  return (
    <div className={css.mapWrap} ref={wrapRef} onMouseLeave={() => setHoverKey(null)}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        role="img"
        aria-label="Product profitability distribution by margin band"
        preserveAspectRatio="xMidYMid meet"
        className={css.mapSvg}
      >
        <defs>
          {/* userSpaceOnUse: the target line is perfectly vertical (x1===x2), so its geometric
             bounding box has zero width — the default objectBoundingBox gradient units would be
             silently ignored by the SVG spec for a zero-area shape, leaving the line unpainted. */}
          <linearGradient id={`marginTargetGrad-${gradientId}`} gradientUnits="userSpaceOnUse" x1="0" y1={padT} x2="0" y2={padT + innerH}>
            <stop offset="0%" stopColor="#dc2626" />
            <stop offset="100%" stopColor="#f97316" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const gy = padT + innerH * (1 - f);
          return <line key={f} x1={padL} x2={w - padR} y1={gy} y2={gy} className={css.gridline} />;
        })}

        {[0, 0.5, 1].map((f) => (
          <text key={`l${f}`} x={padL - 6} y={padT + innerH * (1 - f) + 3} textAnchor="end" className={css.mapAxisTick}>
            {Math.round(maxCount * f)}
          </text>
        ))}
        {[0, 0.5, 1].map((f) => (
          <text key={`r${f}`} x={w - 4} y={padT + innerH * (1 - f) + 3} textAnchor="end" className={css.mapAxisTick}>
            {formatRevenue(maxRevenue * f)}
          </text>
        ))}

        {bands.map((b, i) => {
          const gx = padL + slot * i + slot / 2;
          const countTop = yForCount(b.count);
          const revTop = yForRevenue(b.revenue);
          const isHover = hoverKey === b.key;
          const dim = hoverKey != null && !isHover;
          return (
            <g key={b.key} onMouseEnter={() => setHoverKey(b.key)} style={{ cursor: "pointer" }}>
              <rect
                x={gx - groupW / 2}
                y={countTop}
                width={barW}
                height={Math.max(1, padT + innerH - countTop)}
                rx={3}
                fill="var(--pc-primary)"
                opacity={dim ? 0.35 : 1}
                style={{ transition: "opacity 0.15s ease" }}
              />
              <rect
                x={gx - groupW / 2 + barW + 5}
                y={revTop}
                width={barW}
                height={Math.max(1, padT + innerH - revTop)}
                rx={3}
                fill="var(--pc-secondary-cyan)"
                opacity={dim ? 0.25 : 0.55}
                style={{ transition: "opacity 0.15s ease" }}
              />
              {isHover ? (
                <text x={gx} y={Math.min(countTop, revTop) - 8} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
                  {b.count} · {formatRevenue(b.revenue)}
                </text>
              ) : null}
              <text x={gx} y={height - padB + 18} textAnchor="middle" className={css.mapAxisTick}>
                {b.label}
              </text>
            </g>
          );
        })}

        {targetPosition != null ? (
          <g>
            <line
              x1={padL + slot * targetPosition}
              x2={padL + slot * targetPosition}
              y1={padT}
              y2={padT + innerH}
              stroke={`url(#marginTargetGrad-${gradientId})`}
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            {/* Sits above the plot area entirely (outside the line's own y1..y2 span) so the
               label reads clearly above the dashed line instead of overlapping it. */}
            <text x={padL + slot * targetPosition} y={padT - 6} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
              {targetLabel}
            </text>
          </g>
        ) : null}
      </svg>
      <div className={css.chartLegend}>
        <span>
          <i className={css.legendSwatch} style={{ background: "var(--pc-primary)" }} /> Products (count)
        </span>
        <span>
          <i className={css.legendSwatch} style={{ background: "var(--pc-secondary-cyan)" }} /> Revenue
        </span>
        {targetPosition != null ? (
          <span>
            <i className={css.legendSwatch} style={{ background: "linear-gradient(90deg, #dc2626, #f97316)" }} /> {targetLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
