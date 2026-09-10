"use client";

import css from "../reports.module.css";

export type ExposureSegmentKey = "recoverable" | "highRisk" | "writeOff";

export type ExposureSegment = { key: ExposureSegmentKey; label: string; value: number; count: number };

type Props = {
  segments: ExposureSegment[];
  formatValue: (n: number) => string;
  /** Clicking a segment (or its legend entry) filters the Critical Batches table to just that
   *  action bucket — same click-to-filter convention as every other report chart. */
  onSegmentClick?: (key: ExposureSegmentKey) => void;
  activeKey?: ExposureSegmentKey | null;
};

const SEGMENT_COLOR: Record<ExposureSegmentKey, string> = {
  recoverable: "var(--pc-tone-success)",
  highRisk: "var(--pc-tone-orange)",
  writeOff: "var(--pc-tone-danger)",
};

/** Splits total expiry exposure into business-action buckets — a single segmented value bar
 *  rather than a three-slice donut, since the point is "how much of this can we still act on",
 *  not category composition. Reuses the exact same recommendation each row already carries
 *  (`recommendExpiryAction`), just regrouped: dispose = write-off, priority-dispense = high risk
 *  (may still sell via FEFO, not guaranteed), everything else = recoverable. */
export function ExpiryExposureBar({ segments, formatValue, onSegmentClick, activeKey }: Props) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total <= 0) {
    return <p className={css.emptyNote}>No stock at risk in the selected window.</p>;
  }

  return (
    <div className={css.exposureBarWrap}>
      <div className={css.exposureBarTrack}>
        {segments
          .filter((seg) => seg.value > 0)
          .map((seg) => (
            <button
              key={seg.key}
              type="button"
              className={`${css.exposureBarSegment}${activeKey && activeKey !== seg.key ? ` ${css.exposureBarSegmentDim}` : ""}`}
              style={{ width: `${(seg.value / total) * 100}%`, background: SEGMENT_COLOR[seg.key] }}
              data-tooltip={`${seg.label}: ${formatValue(seg.value)} (${((seg.value / total) * 100).toFixed(1)}%) across ${seg.count} batch${seg.count === 1 ? "" : "es"}`}
              onClick={onSegmentClick ? () => onSegmentClick(seg.key) : undefined}
              disabled={!onSegmentClick}
              aria-pressed={activeKey === seg.key}
            />
          ))}
      </div>
      <div className={css.exposureBarLegendRow}>
        {segments.map((seg) => (
          <button
            key={seg.key}
            type="button"
            className={`${css.exposureBarLegendItem}${activeKey === seg.key ? ` ${css.exposureBarLegendActive}` : ""}`}
            onClick={onSegmentClick ? () => onSegmentClick(seg.key) : undefined}
            disabled={!onSegmentClick}
            aria-pressed={activeKey === seg.key}
          >
            <i className={css.exposureBarSwatch} style={{ background: SEGMENT_COLOR[seg.key] }} />
            <span className={css.exposureBarLegendLabel}>{seg.label}</span>
            <span className={css.exposureBarLegendValue}>{formatValue(seg.value)}</span>
            <span className={css.mutedcell}>({total > 0 ? ((seg.value / total) * 100).toFixed(0) : 0}%)</span>
          </button>
        ))}
      </div>
    </div>
  );
}
