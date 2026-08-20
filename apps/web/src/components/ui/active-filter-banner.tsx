"use client";

import css from "./active-filter-banner.module.css";

export type FilterPill = { key: string; label: string };

type Props = {
  /** Renders nothing when false — callers don't need their own `{active && ...}` guard. */
  active: boolean;
  summary: string;
  pills: FilterPill[];
  onClear: () => void;
  clearTooltip?: string;
};

/**
 * The "Filtered X · N results" banner with a per-filter pill row and a "Clear filter"
 * action — same design everywhere it appears (Products, Catalog, Reports, Inventory,
 * Purchasing, Suppliers, …) instead of each page keeping its own copy of this markup/CSS.
 */
export function ActiveFilterBanner({ active, summary, pills, onClear, clearTooltip }: Props) {
  if (!active) return null;
  return (
    <div className={css.activeFilter}>
      <div className={css.activeFilterMain}>
        <span className={css.activeFilterSummary}>{summary}</span>
        {pills.length > 0 && (
          <div className={css.activeFilterPills}>
            {pills.map((pill) => (
              <span key={pill.key} className={css.filterPill}>
                {pill.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className={css.clearFilter}
        onClick={onClear}
        data-tooltip={clearTooltip}
      >
        Clear filter
      </button>
    </div>
  );
}
