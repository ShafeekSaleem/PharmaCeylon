"use client";

import { useState } from "react";
import css from "../reports.module.css";

type Props = {
  /** [weekday(0=Sun..6=Sat)][hour(0-23)] = summed value */
  grid: number[][];
  weekdayLabels: string[];
  formatValue?: (n: number) => string;
};

const MON_FIRST_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HOUR_TICKS = [0, 4, 8, 12, 16, 20];

function hourLabel(h: number): string {
  if (h === 0) return "12AM";
  if (h < 12) return `${h}AM`;
  if (h === 12) return "12PM";
  return `${h - 12}PM`;
}

/** Sales intensity by weekday × hour-of-day — sequential single-hue (teal) scale, one direction only. */
export function HeatmapGrid({ grid, weekdayLabels, formatValue = (n) => String(Math.round(n)) }: Props) {
  const [hoverCell, setHoverCell] = useState<{ day: number; hour: number } | null>(null);
  const max = Math.max(...grid.flat(), 1);

  function colorFor(v: number): string {
    if (v <= 0) return "var(--pc-muted-bg)";
    const t = Math.min(1, v / max);
    return `color-mix(in srgb, var(--pc-primary) ${Math.round(8 + t * 82)}%, #fff)`;
  }

  return (
    <div className={css.heatmapWrap}>
      <div className={css.heatmapGrid} style={{ "--heatmap-cols": 24 } as React.CSSProperties}>
        <div className={css.heatmapHeaderRow}>
          <span className={css.heatmapCornerLabel} />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className={css.heatmapHourLabel}>
              {HOUR_TICKS.includes(h) ? hourLabel(h) : ""}
            </span>
          ))}
        </div>
        {MON_FIRST_ORDER.map((dayIdx) => (
          <div className={css.heatmapRow} key={dayIdx}>
            <span className={css.heatmapDayLabel}>{weekdayLabels[dayIdx]}</span>
            {grid[dayIdx]!.map((value, hour) => (
              <div
                key={hour}
                className={css.heatmapCell}
                style={{ background: colorFor(value) }}
                data-tooltip={`${weekdayLabels[dayIdx]} ${hourLabel(hour)} — ${formatValue(value)}`}
                onMouseEnter={() => setHoverCell({ day: dayIdx, hour })}
                onMouseLeave={() => setHoverCell(null)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className={css.heatmapLegendRow}>
        <span>Low</span>
        <span className={css.heatmapLegendScale}>
          {[0.15, 0.35, 0.55, 0.75, 1].map((t) => (
            <span key={t} className={css.heatmapLegendSwatch} style={{ background: `color-mix(in srgb, var(--pc-primary) ${Math.round(8 + t * 82)}%, #fff)` }} />
          ))}
        </span>
        <span>High</span>
        {hoverCell ? (
          <span style={{ marginLeft: "auto" }}>
            {weekdayLabels[hoverCell.day]} {hourLabel(hoverCell.hour)}: <b>{formatValue(grid[hoverCell.day]![hoverCell.hour]!)}</b>
          </span>
        ) : null}
      </div>
    </div>
  );
}
