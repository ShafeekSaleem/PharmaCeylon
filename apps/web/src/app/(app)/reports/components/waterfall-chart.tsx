"use client";

import { useEffect, useRef, useState } from "react";
import css from "../reports.module.css";

export type WaterfallStep = {
  key: string;
  label: string;
  /** "total" steps draw a full bar from 0 and reset the running baseline (e.g. Revenue, Gross
   *  Profit, Opening/Closing Stock). "addition"/"deduction" steps float a bar up/down from the
   *  running baseline by the given magnitude (e.g. COGS, Purchases, Sales) — never pass a
   *  negative number here, the chart applies the sign itself. */
  kind: "total" | "addition" | "deduction";
  value: number;
};

type Props = {
  steps: WaterfallStep[];
  formatValue: (n: number) => string;
  height?: number;
};

type Bar = { key: string; label: string; top: number; bottom: number; tone: "total" | "addition" | "deduction"; displayValue: number };

/** Classic ascending/descending bridge chart — a "total" bar resets the baseline, a "deduction"
 *  bar floats down from the current baseline. Used for Gross Profit's Revenue → COGS → Gross
 *  Profit bridge; kept generic (not GP-specific) in case another page needs a bridge later. */
export function WaterfallChart({ steps, formatValue, height = 220 }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  // Measuring the real container width and using it as the viewBox width (instead of a fixed
  // constant scaled via preserveAspectRatio="meet") makes 1 SVG unit == 1 CSS px, so the chart
  // fills the card's width while its height stays exactly fixed — otherwise a wider card makes
  // this aspect-locked SVG render taller, breaking alignment with a sibling card next to it.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(520);
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

  if (steps.length === 0) {
    return (
      <div className={css.mapWrap} ref={wrapRef}>
        <p className={css.emptyNote}>No data for this range yet.</p>
      </div>
    );
  }

  let running = 0;
  const bars: Bar[] = steps.map((step) => {
    if (step.kind === "total") {
      running = step.value;
      return { key: step.key, label: step.label, top: step.value, bottom: 0, tone: "total", displayValue: step.value };
    }
    const magnitude = Math.abs(step.value);
    if (step.kind === "addition") {
      const bottom = running;
      running = running + magnitude;
      return { key: step.key, label: step.label, top: running, bottom, tone: "addition", displayValue: magnitude };
    }
    const top = running;
    running = running - magnitude;
    return { key: step.key, label: step.label, top, bottom: running, tone: "deduction", displayValue: -magnitude };
  });

  const maxVal = Math.max(...bars.map((b) => Math.max(b.top, b.bottom)), 1);
  const w = measuredWidth;
  const padL = 8, padR = 8, padT = 26, padB = 34;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const n = bars.length;
  const slot = innerW / n;
  const barW = Math.min(slot * 0.5, 92);

  const yFor = (v: number) => padT + innerH - (v / maxVal) * innerH;

  return (
    <div className={css.mapWrap} ref={wrapRef} onMouseLeave={() => setHoverKey(null)}>
      <svg
        viewBox={`0 0 ${w} ${height}`}
        role="img"
        aria-label="Profit bridge"
        preserveAspectRatio="xMidYMid meet"
        className={css.mapSvg}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const gy = padT + innerH * (1 - f);
          return <line key={f} x1={padL} x2={w - padR} y1={gy} y2={gy} className={css.gridline} />;
        })}

        {bars.map((b, i) => {
          const cx = padL + slot * i + slot / 2;
          const y1 = yFor(b.top);
          const y2 = yFor(b.bottom);
          const barTop = Math.min(y1, y2);
          const barH = Math.max(2, Math.abs(y2 - y1));
          const isHover = hoverKey === b.key;
          const color = b.tone === "deduction" ? "#dc2626" : b.tone === "addition" ? "#16a34a" : "var(--pc-primary)";
          return (
            <g key={b.key}>
              {i > 0 ? (
                <line
                  x1={padL + slot * (i - 1) + slot / 2 + barW / 2}
                  x2={cx - barW / 2}
                  y1={yFor(bars[i - 1]!.bottom)}
                  y2={yFor(bars[i - 1]!.bottom)}
                  className={css.gridline}
                  strokeDasharray="3 3"
                />
              ) : null}
              <rect
                x={cx - barW / 2}
                y={barTop}
                width={barW}
                height={barH}
                rx={4}
                fill={color}
                opacity={hoverKey == null || isHover ? (b.tone === "total" ? 1 : 0.85) : 0.45}
                onMouseEnter={() => setHoverKey(b.key)}
                style={{ cursor: "pointer", transition: "opacity 0.15s ease" }}
              />
              <text x={cx} y={barTop - 8} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
                {b.tone === "deduction" ? `−${formatValue(Math.abs(b.displayValue))}` : b.tone === "addition" ? `+${formatValue(b.displayValue)}` : formatValue(b.displayValue)}
              </text>
              <text x={cx} y={height - padB + 18} textAnchor="middle" className={css.mapAxisTick}>
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
