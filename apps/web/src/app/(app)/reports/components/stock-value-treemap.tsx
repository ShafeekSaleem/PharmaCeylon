"use client";

import { useMemo } from "react";
import { squarify } from "../lib/treemap";
import css from "../reports.module.css";

export type TreemapNode = {
  id: string;
  label: string;
  value: number;
  share: number;
  units: number;
  daysOfCover: number | null;
};

type Props = {
  /** Pre-sorted descending by value — the caller owns ranking and any "Other" bucketing. */
  nodes: TreemapNode[];
  /** Full-precision value, used only in the hover tooltip. */
  formatValue: (n: number) => string;
  /** Compact value (e.g. "LKR 20.9M") shown inline on the tile itself — defaults to `formatValue`
   *  if the caller doesn't have a compact formatter, but a treemap tile is a chart surface, not a
   *  table cell, so it should almost always get the shorter one. */
  formatTileValue?: (n: number) => string;
  colorOf: (id: string, index: number) => string;
  onTileClick?: (id: string) => void;
};

// Layout canvas for the squarify algorithm — matches the panel's real aspect ratio (see
// `.treemapWrap`'s `aspect-ratio` in reports.module.css, which must match) so tile "squareness"
// is judged against the shape tiles actually render at, not a placeholder square.
const CANVAS_W = 220;
const CANVAS_H = 100;

// Tile-size floors (canvas units, the 220×100 layout space — not rendered pixels) gating how much
// content a tile shows — name only, then +value, then +share — so a small tile (whose real height
// depends on both the data and CANVAS_H, not just one or the other) degrades gracefully instead of
// clipping the last line. The name itself always wraps rather than truncating.
const MIN_TILE_W_FOR_CONTENT = 10;
const MIN_TILE_H_FOR_CONTENT = 8;
const MIN_TILE_H_FOR_VALUE = 16;
const MIN_TILE_H_FOR_SHARE = 27;

/** One tile per top-level COMMERCIAL department, sized by stock value (a squarified treemap, not
 *  a strict area-only slice-and-dice) — reads "where is capital concentrated" at a glance, far
 *  faster than a table of percentages. Clicking a tile with a caller-provided `onTileClick`
 *  drills into that department's own leaf sub-categories (the section component swaps `nodes`). */
export function StockValueTreemap({ nodes, formatValue, formatTileValue, colorOf, onTileClick }: Props) {
  const tileFormat = formatTileValue ?? formatValue;
  const rects = useMemo(() => {
    if (nodes.length === 0) return [];
    const total = nodes.reduce((s, n) => s + n.value, 0);
    if (total <= 0) return [];
    const scaled = nodes.map((n) => (n.value / total) * CANVAS_W * CANVAS_H);
    return squarify(scaled, 0, 0, CANVAS_W, CANVAS_H);
  }, [nodes]);

  if (nodes.length === 0) {
    return <p className={css.emptyNote}>No stock value in this range yet.</p>;
  }

  return (
    <div className={css.treemapWrap}>
      {nodes.map((n, i) => {
        const r = rects[i];
        if (!r) return null;
        const showContent = r.w >= MIN_TILE_W_FOR_CONTENT && r.h >= MIN_TILE_H_FOR_CONTENT;
        const showValue = showContent && r.h >= MIN_TILE_H_FOR_VALUE;
        const showShare = showValue && r.h >= MIN_TILE_H_FOR_SHARE;
        const tooltip = `${n.label}: ${formatValue(n.value)} · ${n.units.toLocaleString("en-IN")} units · ${n.share.toFixed(1)}% share · Cover: ${n.daysOfCover == null ? "—" : `${n.daysOfCover}d`}`;
        const Tag = onTileClick ? "button" : "div";
        return (
          <Tag
            key={n.id}
            type={onTileClick ? "button" : undefined}
            className={css.treemapTile}
            data-tooltip={tooltip}
            style={{
              left: `${(r.x / CANVAS_W) * 100}%`,
              top: `${(r.y / CANVAS_H) * 100}%`,
              width: `${(r.w / CANVAS_W) * 100}%`,
              height: `${(r.h / CANVAS_H) * 100}%`,
              background: colorOf(n.id, i),
              cursor: onTileClick ? "pointer" : "default",
            }}
            onClick={onTileClick ? () => onTileClick(n.id) : undefined}
          >
            {showContent ? (
              <span className={css.treemapTileContent}>
                <span className={css.treemapTileLabel}>{n.label}</span>
                {showValue ? <span className={css.treemapTileValue}>{tileFormat(n.value)}</span> : null}
                {showShare ? <span className={css.treemapTileShare}>{n.share.toFixed(1)}%</span> : null}
              </span>
            ) : null}
          </Tag>
        );
      })}
    </div>
  );
}
