"use client";

import { categoryChildColor } from "../lib/category-mix-colors";
import { CATEGORY_MIX_OTHERS_COLOR } from "../lib/category-mix-colors";
import type { CategoryChildRow } from "../lib/types";
import css from "../reports.module.css";

type Props = {
  parentName: string;
  parentColor: string;
  childRows: CategoryChildRow[];
  formatValue: (n: number) => string;
  maxSegments?: number;
};

/** Horizontal 100%-stacked bar showing how a department's sales split across its own leaf
 *  categories (e.g. Medicines → Pain & Fever / Dermatology / ...), tinted from the department's
 *  own donut slice color so it reads as "zoomed into that slice" rather than a second chart. */
export function CategoryChildBreakdown({ parentName, parentColor, childRows, formatValue, maxSegments = 6 }: Props) {
  const withValues = childRows
    .map((c) => ({ ...c, valueN: Number(c.revenue) }))
    .filter((c) => c.valueN > 0)
    .sort((a, b) => b.valueN - a.valueN);

  if (withValues.length === 0) {
    return null;
  }

  const top = withValues.slice(0, maxSegments);
  const rest = withValues.slice(maxSegments);
  const othersValue = rest.reduce((s, c) => s + c.valueN, 0);
  const total = top.reduce((s, c) => s + c.valueN, 0) + othersValue || 1;
  const segCount = top.length + (othersValue > 0 ? 1 : 0);

  const segments = [
    ...top.map((c, i) => ({
      key: c.categoryId,
      label: c.name,
      value: c.valueN,
      color: categoryChildColor(parentColor, i, segCount),
    })),
    ...(othersValue > 0
      ? [{ key: "others", label: `Others (${rest.length})`, value: othersValue, color: CATEGORY_MIX_OTHERS_COLOR }]
      : []),
  ];

  return (
    <div className={css.childBreakdown}>
      <div className={css.childBreakdownHead}>
        <span>
          <i style={{ background: parentColor }} aria-hidden /> {parentName} breakdown
        </span>
        <b>{formatValue(total)}</b>
      </div>
      <div className={css.childBreakdownBar} role="img" aria-label={`${parentName} category breakdown`}>
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={css.childBreakdownSeg}
            style={{ width: `${Math.max(1.5, (seg.value / total) * 100)}%`, background: seg.color }}
            title={`${seg.label}: ${formatValue(seg.value)} (${((seg.value / total) * 100).toFixed(1)}%)`}
          />
        ))}
      </div>
      <ul className={css.childBreakdownLegend}>
        {segments.map((seg) => (
          <li key={seg.key}>
            <i style={{ background: seg.color }} aria-hidden />
            <span>{seg.label}</span>
            <em>{((seg.value / total) * 100).toFixed(0)}%</em>
          </li>
        ))}
      </ul>
    </div>
  );
}
