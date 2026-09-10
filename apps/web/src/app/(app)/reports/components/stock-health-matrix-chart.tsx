"use client";

import { useEffect, useState } from "react";
import { resolveBubbleCollisions } from "../lib/bubble-layout";
import css from "../reports.module.css";

export type HealthMatrixZone = "deadSlow" | "reorderRisk" | "overstocked" | "monitor" | "healthy";

export type HealthMatrixPoint = {
  id: string;
  label: string;
  categoryName: string;
  velocity: number;
  /** Null (zero-velocity/dead) plots at the chart's top edge — "infinite" cover has nowhere
   *  finite to sit, so it belongs at the extreme rather than being dropped. */
  daysOfCover: number | null;
  value: number;
  units: number;
  daysSinceLastSale: number | null;
  zone: HealthMatrixZone;
};

type Props = {
  points: HealthMatrixPoint[];
  formatValue: (n: number) => string;
  /** Vertical reference line — a representative demand threshold, purely a visual aid (the
   *  authoritative healthy/at-risk call is the server-computed `zone` on each point, never
   *  re-derived here). */
  velocityReference: number;
  /** Horizontal reference line — mirrors the backend's own overstock-cover-days bar. */
  coverReferenceDays: number;
};

const ZONE_COLOR: Record<HealthMatrixZone, string> = {
  deadSlow: "var(--pc-tone-danger)",
  reorderRisk: "var(--pc-tone-orange)",
  overstocked: "var(--pc-tone-amber)",
  monitor: "var(--pc-tone-info)",
  healthy: "var(--pc-tone-success)",
};

const ZONE_LABEL: Record<HealthMatrixZone, string> = {
  deadSlow: "Dead / Slow",
  reorderRisk: "Reorder Risk",
  overstocked: "Overstocked",
  monitor: "Monitor",
  healthy: "Healthy",
};

const MAX_BUBBLES_PER_ZONE = 15;
const COVER_CLAMP_MULTIPLIER = 2; // finite Y-axis top = coverReferenceDays × this, before the "infinite" edge row

/** Demand (velocity) × days-of-cover quadrant, bubble size = stock value — "which inventory is
 *  healthy, understocked, overstocked or dead" at a glance. Pure CSS percentage positioning (same
 *  approach as the benchmark/dumbbell charts) rather than a second SVG viewBox system. Samples the
 *  top N-by-value points per zone rather than plotting the entire catalog — with hundreds of SKUs
 *  a full scatter is unreadable noise; the table below still lists every at-risk item. Overlapping
 *  bubbles (dense clusters at similar velocity/cover) are fanned apart by `resolveBubbleCollisions`
 *  rather than left to stack exactly on top of each other. */
export function StockHealthMatrixChart({ points, formatValue, velocityReference, coverReferenceDays }: Props) {
  // `setPlotEl` (state, not a plain ref) so the ResizeObserver attaches correctly even when the
  // plot div mounts after an initial empty/loading render — a plain useRef's effect only runs once
  // at mount, before the ref would be set on a node that doesn't exist yet.
  const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 640, height: 240 });
  useEffect(() => {
    if (!plotEl) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(plotEl);
    return () => ro.disconnect();
  }, [plotEl]);

  if (points.length === 0) {
    return <p className={css.emptyNote}>No stock to plot for this range yet.</p>;
  }

  const sampled = Object.values(
    points.reduce<Record<string, HealthMatrixPoint[]>>((acc, p) => {
      (acc[p.zone] ??= []).push(p);
      return acc;
    }, {}),
  ).flatMap((zonePoints) => [...zonePoints].sort((a, b) => b.value - a.value).slice(0, MAX_BUBBLES_PER_ZONE));

  const maxVelocity = Math.max(...sampled.map((p) => p.velocity), velocityReference * 2, 1);
  const finiteCovers = sampled.map((p) => p.daysOfCover).filter((d): d is number => d != null);
  const coverTop = Math.max(coverReferenceDays * COVER_CLAMP_MULTIPLIER, ...finiteCovers, 1);
  const maxValue = Math.max(...sampled.map((p) => p.value), 1);

  const xOf = (velocity: number) => Math.min(100, (velocity / maxVelocity) * 100);
  // CSS `top%` directly (not a "distance from bottom" needing a later 100-minus flip) — higher
  // cover sits higher up (smaller top%). Reserves the top 8% of the track as the "infinite cover"
  // row for dead/zero-velocity points, matching `.healthMatrixInfiniteBand`'s own top:0/height:8%.
  const topOf = (cover: number | null) => (cover == null ? 4 : 8 + (1 - Math.min(1, cover / coverTop)) * 92);
  const sizeOf = (value: number) => 10 + Math.sqrt(value / maxValue) * 26; // sqrt scale so area (not radius) tracks value

  const xRefPct = Math.min(96, Math.max(4, xOf(velocityReference)));
  const yRefTopPct = Math.min(96, Math.max(4, topOf(coverReferenceDays)));

  // Collision resolution runs in real pixel space (the measured plot size), not percentages —
  // converted back to percentages afterward for the same CSS positioning every other bubble/line
  // chart on this page uses. Bubble radius/positions also come back already clamped inside the
  // plot's bounds, so no separate percentage clamp is needed to keep edge bubbles from clipping.
  const resolved = resolveBubbleCollisions(
    sampled.map((p) => ({ id: p.id, x: (xOf(p.velocity) / 100) * size.width, y: (topOf(p.daysOfCover) / 100) * size.height, r: sizeOf(p.value) / 2 })),
    size.width,
    size.height,
  );
  const posById = new Map(resolved.map((r) => [r.id, r]));

  return (
    <div className={css.healthMatrixWrap}>
      <div className={css.healthMatrixLegendRow}>
        {(Object.keys(ZONE_LABEL) as HealthMatrixZone[]).map((z) => (
          <span key={z} className={css.benchmarkLegendItem}>
            <i className={css.benchmarkDotSwatch} style={{ background: ZONE_COLOR[z] }} /> {ZONE_LABEL[z]}
          </span>
        ))}
      </div>
      <div className={css.healthMatrixBody}>
        <div className={css.healthMatrixAxisY}>
          <span className={css.healthMatrixAxisEnd}>High</span>
          <span className={css.healthMatrixAxisYTitle}>Days of Cover</span>
          <span className={css.healthMatrixAxisEnd}>Low</span>
        </div>
        <div className={css.healthMatrixPlotCol}>
          <div className={css.healthMatrixPlot} ref={setPlotEl}>
            <div className={css.healthMatrixGridlineY} style={{ left: `${xRefPct}%` }} />
            <div className={css.healthMatrixGridlineX} style={{ top: `${yRefTopPct}%` }} />
            <div className={css.healthMatrixInfiniteBand} />
            {sampled.map((p) => {
              const pos = posById.get(p.id)!;
              const left = (pos.x / size.width) * 100;
              const top = (pos.y / size.height) * 100;
              const bubbleSize = sizeOf(p.value);
              const tooltip = `${p.label} (${p.categoryName}) — ${p.units.toLocaleString("en-IN")} units, ${formatValue(p.value)}, ${p.velocity.toFixed(2)}/day, ${p.daysOfCover == null ? "no cover (no recent sales)" : `${p.daysOfCover}d cover`}, last sale ${p.daysSinceLastSale == null ? "never" : `${p.daysSinceLastSale}d ago`} — ${ZONE_LABEL[p.zone]}`;
              return (
                <div
                  key={p.id}
                  className={css.healthMatrixBubble}
                  style={{ left: `${left}%`, top: `${top}%`, width: bubbleSize, height: bubbleSize, background: ZONE_COLOR[p.zone] }}
                  data-tooltip={tooltip}
                />
              );
            })}
          </div>
          <div className={css.healthMatrixAxisX}>
            <span className={css.healthMatrixAxisEnd}>Low</span>
            <span className={css.healthMatrixAxisXTitle}>Demand / Sales Velocity</span>
            <span className={css.healthMatrixAxisEnd}>High</span>
          </div>
        </div>
      </div>
    </div>
  );
}
