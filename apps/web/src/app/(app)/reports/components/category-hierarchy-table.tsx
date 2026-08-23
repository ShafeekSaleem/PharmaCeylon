"use client";

import { Fragment, useEffect, useState } from "react";
import { IconChevronRight } from "@/components/icons";
import { CategoryIconBadge } from "@/lib/category-icons";
import { InlineBarCell } from "./inline-bar-cell";
import { formatMoney, formatPctTrend } from "../lib/format";
import css from "../reports.module.css";

export type HierarchyChildRow = {
  categoryId: string;
  name: string;
  revenueN: number;
  costN: number;
  marginN: number;
  marginPct: number;
};

export type HierarchyParentRow = HierarchyChildRow & {
  contributionPct: number;
  growthPct: number | null;
  children: HierarchyChildRow[];
};

type SortKey = "name" | "revenueN" | "costN" | "marginN" | "marginPct" | "contributionPct" | "growthPct";

type Column = { key: SortKey; header: string; align?: "right" };

const COLUMNS: Column[] = [
  { key: "name", header: "Category" },
  { key: "revenueN", header: "Revenue", align: "right" },
  { key: "costN", header: "COGS", align: "right" },
  { key: "marginN", header: "Gross Profit", align: "right" },
  { key: "marginPct", header: "Margin %", align: "right" },
  { key: "contributionPct", header: "Contribution %", align: "right" },
  { key: "growthPct", header: "Growth", align: "right" },
];

type Props = {
  rows: HierarchyParentRow[];
  loading?: boolean;
  emptyTitle?: string;
  /** When set, that row is force-expanded in addition to whatever the user has toggled — e.g. a
   *  filter/selection elsewhere on the page drilling into one category. */
  focusId?: string | null;
};

/** Bespoke (not the generic `DataTable`) expandable parent/child table: parent rows are
 *  sortable, but a parent's children always render directly beneath it regardless of sort —
 *  `DataTable`'s single flat sort would otherwise scatter children away from their parent. */
export function CategoryHierarchyTable({ rows, loading = false, emptyTitle = "No categories match", focusId = null }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("marginN");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    if (!focusId) return;
    setExpanded((cur) => (cur.has(focusId) ? cur : new Set(cur).add(focusId)));
  }, [focusId]);

  const maxRevenue = Math.max(1, ...rows.map((r) => r.revenueN));

  function toggleExpand(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function valueFor(row: HierarchyParentRow, key: SortKey): string | number {
    if (key === "growthPct") return row.growthPct ?? Number.NEGATIVE_INFINITY;
    return row[key];
  }

  const sorted = [...rows].sort((a, b) => {
    const av = valueFor(a, sortKey);
    const bv = valueFor(b, sortKey);
    const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return sortDir === "asc" ? cmp : -cmp;
  });

  if (loading) {
    return (
      <div className={css.hierTableWrap}>
        <table className={css.hierTable}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} style={{ textAlign: c.align }}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i}>
                {COLUMNS.map((c) => (
                  <td key={c.key}>
                    <div className={css.hierSkeleton} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className={css.emptyNote}>{emptyTitle}</p>;
  }

  return (
    <div className={css.hierTableWrap}>
      <table className={css.hierTable}>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                style={{ textAlign: c.align }}
                className={css.hierSortable}
                onClick={() => toggleSort(c.key)}
              >
                <span className={css.hierThInner}>
                  {c.header}
                  <span className={`${css.hierSortIcon}${sortKey === c.key ? ` ${css.hierSortActive}` : ""}`}>
                    {sortKey === c.key && sortDir === "desc" ? "▼" : "▲"}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const isOpen = expanded.has(p.categoryId);
            return (
              <Fragment key={p.categoryId}>
                <tr className={p.categoryId === focusId ? `${css.hierParentRow} ${css.hierParentRowFocus}` : css.hierParentRow}>
                  <td>
                    <button
                      type="button"
                      className={css.hierExpandBtn}
                      onClick={() => toggleExpand(p.categoryId)}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? `Collapse ${p.name}` : `Expand ${p.name}`}
                      disabled={p.children.length === 0}
                    >
                      {p.children.length > 0 ? <IconChevronRight size={13} className={isOpen ? css.hierExpandIconOpen : ""} /> : null}
                    </button>
                    <CategoryIconBadge name={p.name} size={18} className={css.hierCategoryIcon} />
                    {p.name}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <InlineBarCell valueLabel={formatMoney(p.revenueN)} pct={(p.revenueN / maxRevenue) * 100} />
                  </td>
                  <td style={{ textAlign: "right" }} className={css.mutedcell}>{formatMoney(p.costN)}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(p.marginN)}</td>
                  <td style={{ textAlign: "right" }}>{p.marginPct.toFixed(1)}%</td>
                  <td style={{ textAlign: "right" }}>{p.contributionPct.toFixed(1)}%</td>
                  <td style={{ textAlign: "right" }}>
                    {p.growthPct == null ? "—" : <span className={p.growthPct >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(p.growthPct)}</span>}
                  </td>
                </tr>
                {isOpen
                  ? p.children.map((c) => (
                      <tr key={c.categoryId} className={css.hierChildRow}>
                        <td className={css.hierChildName}>{c.name}</td>
                        <td style={{ textAlign: "right" }}>
                          <InlineBarCell valueLabel={formatMoney(c.revenueN)} pct={(c.revenueN / maxRevenue) * 100} />
                        </td>
                        <td style={{ textAlign: "right" }} className={css.mutedcell}>{formatMoney(c.costN)}</td>
                        <td style={{ textAlign: "right" }}>{formatMoney(c.marginN)}</td>
                        <td style={{ textAlign: "right" }}>{c.marginPct.toFixed(1)}%</td>
                        <td style={{ textAlign: "right" }} className={css.mutedcell}>—</td>
                        <td style={{ textAlign: "right" }} className={css.mutedcell}>—</td>
                      </tr>
                    ))
                  : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
