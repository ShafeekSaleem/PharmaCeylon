"use client";

import type { ReactNode } from "react";
import { DataTable, type Column } from "@/components/ui/data-table";
import { InlineBarCell } from "./inline-bar-cell";
import css from "../reports.module.css";

export type RankOption = { key: string; label: string };
export type RankingExtraColumn<T> = { key: string; header: string; align?: "left" | "right"; render: (row: T) => ReactNode };

type Props<T> = {
  id?: string;
  title: string;
  subtitle?: string;
  rankOptions?: RankOption[];
  rankBy?: string;
  onRankByChange?: (key: string) => void;
  rows: T[];
  rowKey: (row: T) => string;
  primaryHeader?: string;
  primaryLabel: (row: T) => string;
  primarySub?: (row: T) => string | undefined;
  barHeader?: string;
  barValue: (row: T) => number;
  barLabel: (row: T) => string;
  danger?: boolean;
  extraColumns?: RankingExtraColumn<T>[];
  footer?: ReactNode;
  loading?: boolean;
  emptyTitle?: string;
  /** Caps the table body to a fixed height with internal scroll (e.g. "17.5rem") instead of letting
   * the card grow with the row count — keeps the card's overall height consistent with its sibling
   * even when showing a longer top-N list. */
  maxBodyHeight?: string;
  /** Rows per page — enables the DataTable's built-in pagination when smaller than `rows.length`
   * (e.g. 10 rows/page over a 50-row top-N list) instead of showing every row at once. */
  pageSize?: number;
  /** Fires when a row is clicked — for a caller that wants the selection to drive a downstream
   *  filter (e.g. narrowing a detail table to just this row). */
  onRowClick?: (row: T) => void;
  /** The row to show as persistently selected — the caller's own filter state. */
  activeId?: string | null;
};

/** A ranked leaderboard: # · name · thin magnitude bar · caller-supplied columns, with an optional
 * "Rank by" segmented control. Shared by every "top N" report card (Margin by Product, Product Sales,
 * Category Sales, Margin by Category, Overview previews) so the rank/bar/table wiring lives once. */
export function RankingTableCard<T>({
  id,
  title,
  subtitle,
  rankOptions,
  rankBy,
  onRankByChange,
  rows,
  rowKey,
  primaryHeader = "Product",
  primaryLabel,
  primarySub,
  barHeader = "Value",
  barValue,
  barLabel,
  danger,
  extraColumns = [],
  footer,
  loading,
  emptyTitle,
  maxBodyHeight,
  pageSize,
  onRowClick,
  activeId,
}: Props<T>) {
  const max = Math.max(...rows.map(barValue), 1);

  const columns: Column<T>[] = [
    { key: "__rank", header: "#", render: (_r, i) => <span className={css.rowNum}>{i + 1}</span> },
    {
      key: "__primary",
      header: primaryHeader,
      render: (r) => (
        <>
          <span className={activeId != null && activeId === rowKey(r) ? css.rankingPrimaryActive : undefined}>{primaryLabel(r)}</span>
          {primarySub?.(r) ? <div className={css.mutedcell}>{primarySub(r)}</div> : null}
        </>
      ),
    },
    {
      key: "__bar",
      header: barHeader,
      align: "right",
      render: (r) => <InlineBarCell valueLabel={barLabel(r)} pct={(barValue(r) / max) * 100} danger={danger} />,
    },
    ...extraColumns.map((c) => ({ key: c.key, header: c.header, align: c.align, render: c.render })),
  ];

  return (
    <div className={css.card} id={id}>
      <div className={css.cardhead}>
        <div>
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {rankOptions && rankOptions.length > 0 ? (
          <div className={css.rankToggle}>
            <span style={{ fontSize: "0.76rem", color: "var(--pc-muted-fg)", alignSelf: "center", marginRight: "0.2rem" }}>Rank by</span>
            <div className={css.segmented}>
              {rankOptions.map((o) => (
                <button key={o.key} type="button" className={rankBy === o.key ? css.on : undefined} onClick={() => onRankByChange?.(o.key)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className={maxBodyHeight ? css.rankingScroll : undefined} style={maxBodyHeight ? { maxHeight: maxBodyHeight } : undefined}>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={rowKey}
          loading={loading}
          pageSize={pageSize ?? (rows.length || 10)}
          noHorizontalScroll
          compact
          stickyHeader={!!maxBodyHeight}
          emptyTitle={emptyTitle ?? "No data for this range"}
          onRowClick={onRowClick}
        />
      </div>
      {footer}
    </div>
  );
}
