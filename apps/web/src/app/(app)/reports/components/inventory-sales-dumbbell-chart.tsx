"use client";

import { useState } from "react";
import css from "../reports.module.css";

export type DumbbellRow = {
  id: string;
  label: string;
  inventoryPct: number;
  inventoryValue: number;
  salesPct: number;
  salesValue: number;
};

type Props = {
  /** Already sorted (descending by inventoryPct) — the caller owns ranking. */
  rows: DumbbellRow[];
  formatValue: (n: number) => string;
  onRowClick?: (id: string) => void;
  activeId?: string | null;
};

const ROW_H = 32;
const AXIS_H = 22;

/** Horizontal connected-dot ("dumbbell") chart: each department gets two dots on a shared 0-100%
 *  share axis — one for its slice of inventory value, one for its slice of sales revenue — joined
 *  by a stem so the gap between "capital tied up" and "revenue generated" reads at a glance. Reuses
 *  the Margin-by-Category benchmark chart's grid/label/plot scaffolding (same pure-CSS-position
 *  layout, no second SVG-vs-DOM sizing model to maintain) with two dot colors instead of a
 *  dot-vs-line comparison. */
export function InventorySalesDumbbellChart({ rows, formatValue, onRowClick, activeId }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className={css.emptyNote}>No comparable inventory/sales data for this range yet.</p>;
  }

  const maxPct = Math.max(...rows.map((r) => Math.max(r.inventoryPct, r.salesPct)), 1) * 1.15;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxPct);
  const pctOf = (v: number) => Math.max(0, Math.min(100, (v / maxPct) * 100));
  const rowsHeight = rows.length * ROW_H;
  const plotHeight = rowsHeight + AXIS_H;

  return (
    <div className={css.benchmarkChart}>
      <div className={css.benchmarkLegendRow}>
        <span className={css.benchmarkLegendItem}>
          <i className={`${css.benchmarkDotSwatch} ${css.dumbbellSwatchInventory}`} /> Inventory Share
        </span>
        <span className={css.benchmarkLegendItem}>
          <i className={`${css.benchmarkDotSwatch} ${css.dumbbellSwatchSales}`} /> Sales Share
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
          {ticks.map((t, i) => (
            <div key={i} className={css.benchmarkGridline} style={{ left: `${pctOf(t)}%`, height: rowsHeight }} />
          ))}
          {rows.map((r, i) => {
            const xInv = pctOf(r.inventoryPct);
            const xSales = pctOf(r.salesPct);
            const stemLeft = Math.min(xInv, xSales);
            const stemWidth = Math.max(0.4, Math.abs(xInv - xSales));
            const isActive = activeId === r.id;
            const isHovered = hoverId === r.id;
            const tooltip = `${r.label} — Inventory ${r.inventoryPct.toFixed(1)}% (${formatValue(r.inventoryValue)}) vs Sales ${r.salesPct.toFixed(1)}% (${formatValue(r.salesValue)})`;
            return (
              <div
                key={r.id}
                className={`${css.benchmarkRow} ${onRowClick ? css.benchmarkRowClickable : ""} ${isHovered ? css.benchmarkRowHover : ""}`}
                style={{ top: i * ROW_H, height: ROW_H }}
                onClick={onRowClick ? () => onRowClick(r.id) : undefined}
                onMouseEnter={() => setHoverId(r.id)}
                data-tooltip={tooltip}
              >
                <div className={css.dumbbellStem} style={{ left: `${stemLeft}%`, width: `${stemWidth}%` }} />
                <div className={`${css.dumbbellDot} ${css.dumbbellDotInventory} ${isActive ? css.benchmarkDotActive : ""}`} style={{ left: `${xInv}%` }} />
                <div className={`${css.dumbbellDot} ${css.dumbbellDotSales} ${isActive ? css.benchmarkDotActive : ""}`} style={{ left: `${xSales}%` }} />
              </div>
            );
          })}
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
