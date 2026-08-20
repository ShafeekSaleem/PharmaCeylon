"use client";

import { useState } from "react";
import css from "../reports.module.css";

export type WaterfallStep = {
  key: string;
  label: string;
  /** "total" steps draw a full bar from 0 and reset the running baseline (e.g. Revenue, Gross
   *  Profit). "deduction" steps draw a floating bar for the positive magnitude subtracted from
   *  the running baseline (e.g. COGS) — never pass a negative number here, the chart negates it. */
  kind: "total" | "deduction";
  value: number;
};

type Props = {
  steps: WaterfallStep[];
  formatValue: (n: number) => string;
  height?: number;
};

type Bar = { key: string; label: string; top: number; bottom: number; tone: "total" | "deduction"; displayValue: number };

/** Classic ascending/descending bridge chart — a "total" bar resets the baseline, a "deduction"
 *  bar floats down from the current baseline. Used for Gross Profit's Revenue → COGS → Gross
 *  Profit bridge; kept generic (not GP-specific) in case another page needs a bridge later. */
export function WaterfallChart({ steps, formatValue, height = 220 }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  if (steps.length === 0) {
    return <p className={css.emptyNote}>No data for this range yet.</p>;
  }

  let running = 0;
  const bars: Bar[] = steps.map((step) => {
    if (step.kind === "total") {
      running = step.value;
      return { key: step.key, label: step.label, top: step.value, bottom: 0, tone: "total", displayValue: step.value };
    }
    const magnitude = Math.abs(step.value);
    const top = running;
    running = running - magnitude;
    return { key: step.key, label: step.label, top, bottom: running, tone: "deduction", displayValue: -magnitude };
  });

  const maxVal = Math.max(...bars.map((b) => Math.max(b.top, b.bottom)), 1);
  const w = 520;
  const padL = 8, padR = 8, padT = 26, padB = 34;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  const n = bars.length;
  const slot = innerW / n;
  const barW = Math.min(slot * 0.5, 92);

  const yFor = (v: number) => padT + innerH - (v / maxVal) * innerH;

  return (
    <div className={css.mapWrap} onMouseLeave={() => setHoverKey(null)}>
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
          const color = b.tone === "deduction" ? "#dc2626" : "var(--pc-primary)";
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
                opacity={hoverKey == null || isHover ? (b.tone === "deduction" ? 0.85 : 1) : 0.45}
                onMouseEnter={() => setHoverKey(b.key)}
                style={{ cursor: "pointer", transition: "opacity 0.15s ease" }}
              />
              <text x={cx} y={barTop - 8} textAnchor="middle" className={css.mapAxisTick} fontWeight={700}>
                {b.tone === "deduction" ? `−${formatValue(Math.abs(b.displayValue))}` : formatValue(b.displayValue)}
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
