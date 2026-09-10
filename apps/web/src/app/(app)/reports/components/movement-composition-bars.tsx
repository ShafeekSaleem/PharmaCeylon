"use client";

import css from "../reports.module.css";

export type CompositionRow = { key: string; label: string; direction: "in" | "out"; units: number };

type Props = {
  rows: CompositionRow[];
};

const INBOUND_PALETTE = ["var(--pc-primary)", "#14b8a6", "#5eead4", "#99f6e4"];
const OUTBOUND_PALETTE = ["var(--pc-tone-danger)", "var(--pc-tone-orange)", "var(--pc-tone-orange-soft)", "#fdba74"];

function DirectionBar({ title, rows, palette }: { title: string; rows: CompositionRow[]; palette: string[] }) {
  const total = rows.reduce((s, r) => s + r.units, 0);
  return (
    <div className={css.exposureBarWrap}>
      <span className={css.compositionBarTitle}>{title}</span>
      {total <= 0 ? (
        <p className={css.emptyNote}>No {title.toLowerCase()} movement in this range.</p>
      ) : (
        <>
          <div className={css.exposureBarTrack}>
            {rows.map((r, i) => (
              <div
                key={r.key}
                className={css.exposureBarSegment}
                style={{ width: `${(r.units / total) * 100}%`, background: palette[i % palette.length] }}
                data-tooltip={`${r.label}: ${r.units.toLocaleString("en-IN")} units (${((r.units / total) * 100).toFixed(1)}%)`}
              />
            ))}
          </div>
          <div className={css.exposureBarLegendRow}>
            {rows.map((r, i) => (
              <span key={r.key} className={css.exposureBarLegendItem}>
                <i className={css.exposureBarSwatch} style={{ background: palette[i % palette.length] }} />
                <span className={css.exposureBarLegendLabel}>{r.label}</span>
                <span className={css.mutedcell}>{r.units.toLocaleString("en-IN")}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Compact horizontal stacked-bar breakdown of each direction's own movement sub-types — kept
 *  visually distinct from the diverging-bar trend above it (that one shows in/out over time; this
 *  one shows what makes up each direction, right now, for the whole selected range). */
export function MovementCompositionBars({ rows }: Props) {
  const inbound = rows.filter((r) => r.direction === "in");
  const outbound = rows.filter((r) => r.direction === "out");
  return (
    <div className={css.compositionBarsWrap}>
      <DirectionBar title="Inbound" rows={inbound} palette={INBOUND_PALETTE} />
      <DirectionBar title="Outbound" rows={outbound} palette={OUTBOUND_PALETTE} />
    </div>
  );
}
