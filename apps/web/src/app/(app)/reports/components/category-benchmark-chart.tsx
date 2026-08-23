"use client";

import { useState } from "react";
import css from "../reports.module.css";

export type BenchmarkRow = { id: string; label: string; marginPct: number };

type Props = {
  /** Already sorted (descending by marginPct) — the caller owns ranking. */
  rows: BenchmarkRow[];
  benchmarkPct: number;
  benchmarkLabel: string;
  onRowClick?: (id: string) => void;
  activeId?: string | null;
};

const ROW_H = 32;
const AXIS_H = 22;

/** Dumbbell/lollipop chart: each category's margin % plotted as a dot against a shared
 *  benchmark line, with a stem connecting the two — reads "how far above/below the benchmark"
 *  at a glance across every category, sorted from strongest to weakest. Pure CSS percentage
 *  positioning (not SVG), so row labels stay crisp text and the layout never needs a
 *  width-vs-height reconciliation the way a scaled SVG viewBox would. */
export function CategoryBenchmarkChart({ rows, benchmarkPct, benchmarkLabel, onRowClick, activeId }: Props) {
  // The name column and the plot column are separate DOM subtrees (two grid cells, not
  // parent/child), so a pure CSS :hover on one can't reach the other — track the hovered
  // category once here and apply it to both sides.
  const [hoverId, setHoverId] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className={css.emptyNote}>No categorized sales in this range yet.</p>;
  }

  const maxVal = Math.max(...rows.map((r) => r.marginPct), benchmarkPct, 1) * 1.15;
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => f * maxVal);
  const pctOf = (v: number) => Math.max(0, Math.min(100, (v / maxVal) * 100));
  const benchmarkX = pctOf(benchmarkPct);
  const rowsHeight = rows.length * ROW_H;
  const plotHeight = rowsHeight + AXIS_H;

  return (
    <div className={css.benchmarkChart}>
      <div className={css.benchmarkLegendRow}>
        <span className={css.benchmarkLegendItem}>
          <i className={css.benchmarkDotSwatch} /> Category Margin
        </span>
        <span className={css.benchmarkLegendItem}>
          <i className={css.benchmarkLineSwatch} /> Benchmark ({benchmarkLabel})
        </span>
      </div>
      <div className={css.benchmarkGrid}>
        <div className={css.benchmarkLabels}>
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`${css.benchmarkLabelBtn} ${activeId === r.id ? css.benchmarkLabelActive : ""} ${hoverId === r.id ? css.benchmarkLabelHover : ""}`}
              style={{ height: ROW_H }}
              onClick={onRowClick ? () => onRowClick(r.id) : undefined}
              onMouseEnter={() => setHoverId(r.id)}
              onMouseLeave={() => setHoverId(null)}
              disabled={!onRowClick}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className={css.benchmarkPlot} style={{ height: plotHeight }} onMouseLeave={() => setHoverId(null)}>
          {/* Thin vertical gridlines at each axis tick, spanning just the row area. */}
          {ticks.map((t, i) => (
            <div key={i} className={css.benchmarkGridline} style={{ left: `${pctOf(t)}%`, height: rowsHeight }} />
          ))}
          <div className={css.benchmarkLine} style={{ left: `${benchmarkX}%`, height: rowsHeight }} />
          {rows.map((r, i) => {
            const x = pctOf(r.marginPct);
            const above = r.marginPct >= benchmarkPct;
            const stemLeft = Math.min(x, benchmarkX);
            const stemWidth = Math.max(0.4, Math.abs(x - benchmarkX));
            const isActive = activeId === r.id;
            const isHovered = hoverId === r.id;
            return (
              <div
                key={r.id}
                className={`${css.benchmarkRow} ${onRowClick ? css.benchmarkRowClickable : ""} ${isHovered ? css.benchmarkRowHover : ""}`}
                style={{ top: i * ROW_H, height: ROW_H }}
                onClick={onRowClick ? () => onRowClick(r.id) : undefined}
                onMouseEnter={() => setHoverId(r.id)}
              >
                <div
                  className={`${css.benchmarkStem} ${above ? css.benchmarkStemUp : css.benchmarkStemDown}`}
                  style={{ left: `${stemLeft}%`, width: `${stemWidth}%` }}
                />
                <div
                  className={`${css.benchmarkDot} ${above ? css.benchmarkDotUp : css.benchmarkDotDown} ${isActive ? css.benchmarkDotActive : ""}`}
                  style={{ left: `${x}%` }}
                />
                <span className={`${css.benchmarkValue} ${above ? css.deltaUp : css.deltaDown}`} style={{ left: `${x}%` }}>
                  {r.marginPct.toFixed(1)}%
                </span>
              </div>
            );
          })}
          {/* Axis ticks live below the rows, not above — reads more naturally as a baseline. */}
          <div className={css.benchmarkTicks} style={{ top: rowsHeight, height: AXIS_H }}>
            {ticks.map((t, i) => (
              <span key={i} style={{ left: `${pctOf(t)}%` }}>
                {Math.round(t)}%
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
