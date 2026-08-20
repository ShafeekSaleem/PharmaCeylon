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
};

/** Same donut design as `PaymentMixCard` (`SimpleDonutChart`), with the top N categories as
 *  slices and everything past that folded into a single "Others" slice so the chart and
 *  legend stay readable even when a tenant has dozens of categories. */
export function CategoryMixCard({ rows, totalRevenue, maxSlices = 8, onHoverRow }: Props) {
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

  return (
    <SimpleDonutChart
      slices={slices}
      centerValue={formatMoney(totalRevenue)}
      centerLabel="Total Sales"
      legendBeside
      formatValue={formatMoney}
      onHoverChange={onHoverRow ? (index) => onHoverRow(index != null ? (top[index]?.id ?? null) : null) : undefined}
    />
  );
}
