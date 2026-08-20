"use client";

import { useMemo } from "react";
import { formatMoney, formatPctTrend } from "../lib/format";
import css from "../reports.module.css";

export type TreemapTile = {
  id: string;
  label: string;
  color: string;
  revenue: number;
  cost: number;
  /** Sizing value — tile area is proportional to this (Gross Profit). */
  margin: number;
  marginPct: number;
  contributionPct: number;
  growthPct: number | null;
};

type Props = {
  tiles: TreemapTile[];
  height?: number;
  onTileClick?: (id: string) => void;
};

type Rect = { x: number; y: number; w: number; h: number };

/** Squarified treemap layout (Bruls/Huizing/van Wijk) over a 100×100 virtual box — values must
 *  already be pre-scaled so they sum to the box's area (10000) before calling this. */
function squarify(values: number[], rect: Rect): Rect[] {
  if (values.length === 0) return [];
  const worstRatio = (row: number[], length: number): number => {
    const sum = row.reduce((a, b) => a + b, 0);
    const rowMax = Math.max(...row);
    const rowMin = Math.min(...row);
    const sq = length * length;
    return Math.max((sq * rowMax) / (sum * sum), (sum * sum) / (sq * rowMin));
  };
  const layoutRow = (row: number[], length: number, r: Rect, horizontal: boolean): Rect[] => {
    const sum = row.reduce((a, b) => a + b, 0);
    const thickness = sum / length;
    let offset = horizontal ? r.x : r.y;
    return row.map((v) => {
      const size = v / thickness;
      const out: Rect = horizontal ? { x: offset, y: r.y, w: size, h: thickness } : { x: r.x, y: offset, w: thickness, h: size };
      offset += size;
      return out;
    });
  };

  const result: Rect[] = [];
  let remaining = [...values];
  let current = { ...rect };
  while (remaining.length > 0) {
    const horizontal = current.w >= current.h;
    const length = horizontal ? current.h : current.w;
    let row = [remaining[0]!];
    let i = 1;
    while (i < remaining.length) {
      const testRow = [...row, remaining[i]!];
      if (worstRatio(testRow, length) <= worstRatio(row, length)) {
        row = testRow;
        i++;
      } else break;
    }
    result.push(...layoutRow(row, length, current, horizontal));
    const rowThickness = row.reduce((a, b) => a + b, 0) / length;
    current = horizontal
      ? { x: current.x, y: current.y + rowThickness, w: current.w, h: current.h - rowThickness }
      : { x: current.x + rowThickness, y: current.y, w: current.w - rowThickness, h: current.h };
    remaining = remaining.slice(row.length);
  }
  return result;
}

/** Gross Profit Mix by Commercial Category — one tile per top-level department, area = Gross
 *  Profit. Hand-rolled (no chart library, matching this app's convention), rendered as absolutely
 *  positioned divs over a percentage-based 100×100 virtual box so it stays responsive without SVG
 *  text-wrapping headaches. */
export function CategoryTreemap({ tiles, height = 280, onTileClick }: Props) {
  const positive = useMemo(() => [...tiles].filter((t) => t.margin > 0).sort((a, b) => b.margin - a.margin), [tiles]);

  const rects = useMemo(() => {
    if (positive.length === 0) return [];
    const total = positive.reduce((s, t) => s + t.margin, 0) || 1;
    const scale = 10000 / total;
    return squarify(
      positive.map((t) => t.margin * scale),
      { x: 0, y: 0, w: 100, h: 100 },
    );
  }, [positive]);

  if (positive.length === 0) {
    return <p className={css.emptyNote}>No category gross profit for this range yet.</p>;
  }

  return (
    <div className={css.treemapWrap} style={{ height }}>
      {positive.map((tile, i) => {
        const r = rects[i]!;
        const small = r.w < 13 || r.h < 13;
        return (
          <button
            type="button"
            key={tile.id}
            className={css.treemapTile}
            style={{
              left: `${r.x}%`,
              top: `${r.y}%`,
              width: `${r.w}%`,
              height: `${r.h}%`,
              background: tile.color,
            }}
            onClick={onTileClick ? () => onTileClick(tile.id) : undefined}
            data-tooltip={`${tile.label} — Revenue ${formatMoney(tile.revenue)} · COGS ${formatMoney(tile.cost)} · Gross Profit ${formatMoney(tile.margin)} · Margin ${tile.marginPct.toFixed(1)}% · Contribution ${tile.contributionPct.toFixed(1)}%${tile.growthPct != null ? ` · Growth ${formatPctTrend(tile.growthPct)}` : ""}`}
          >
            {!small ? (
              <span className={css.treemapTileBody}>
                <b>{tile.label}</b>
                <em>{formatMoney(tile.margin)}</em>
                <small>{tile.contributionPct.toFixed(1)}%</small>
              </span>
            ) : (
              <span className={css.treemapTileBodyCompact}>{tile.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
