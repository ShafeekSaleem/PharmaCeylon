"use client";

import { SimpleDonutChart } from "@/app/(app)/dashboard/components/simple-charts";
import { formatMoney } from "../lib/format";
import { CATEGORY_MIX_OTHERS_COLOR, categoryMixColor } from "../lib/category-mix-colors";
import css from "../reports.module.css";

type MixRow = { id: string; label: string; value: number };

type Props = {
  /** Already sorted descending by `value` — the caller owns ranking/filtering. */
  rows: MixRow[];
  totalRevenue: number;
  maxSlices?: number;
  /** Fires with the hovered/focused row's `id`, or null when nothing is active — lets the
   *  caller drive a secondary breakdown view off the same slice the user is pointing at. */
  onHoverRow?: (id: string | null) => void;
  /** Fires with a slice's `id` when clicked — for a caller that wants the selection to persist
   *  after the pointer moves away (distinct from the transient hover preview above), e.g. to
   *  drive a downstream table's filter. Never fires for the "Others" slice (it has no single id). */
  onSelectRow?: (id: string) => void;
  /** The row to show as persistently selected, independent of hover — the caller's own filter
   *  state, driven by `onSelectRow`. */
  activeId?: string | null;
};

/** Same donut design as the dashboard's `SimpleDonutChart`, with the top N categories as
 *  slices and everything past that folded into a single "Others" slice so the chart and
 *  legend stay readable even when a tenant has dozens of categories. */
export function CategoryMixCard({ rows, totalRevenue, maxSlices = 8, onHoverRow, onSelectRow, activeId }: Props) {
  if (rows.length === 0) {
    return <p className={css.emptyNote}>No sales data for this range yet.</p>;
  }

  const top = rows.slice(0, maxSlices);
  const rest = rows.slice(maxSlices);
  const othersValue = rest.reduce((s, r) => s + r.value, 0);

  const slices = [
    ...top.map((r, i) => ({ label: r.label, value: r.value, color: categoryMixColor(i) })),
    ...(othersValue > 0
      ? [{ label: `Others (${rest.length})`, value: othersValue, color: CATEGORY_MIX_OTHERS_COLOR }]
      : []),
  ];
  const activeIndex = activeId ? top.findIndex((r) => r.id === activeId) : -1;

  return (
    <SimpleDonutChart
      slices={slices}
      centerValue={formatMoney(totalRevenue)}
      centerLabel="Total Sales"
      legendBeside
      formatValue={formatMoney}
      onHoverChange={onHoverRow ? (index) => onHoverRow(index != null ? (top[index]?.id ?? null) : null) : undefined}
      onSliceClick={onSelectRow ? (index) => { const id = top[index]?.id; if (id) onSelectRow(id); } : undefined}
      activeIndex={activeIndex >= 0 ? activeIndex : null}
    />
  );
}
