"use client";

import { useEffect, useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/icons";
import css from "../reports.module.css";

export type BarRow = {
  key: string;
  label: string;
  sublabel?: string;
  /** Drives the fill width, scaled against the largest `value` in the list. */
  value: number;
  valueLabel: string;
  subValue?: string;
  /** Pre-formatted signed change vs. the compare period, e.g. "+12.5%" — colored green/red by `deltaTone`. */
  deltaLabel?: string;
  deltaTone?: "positive" | "negative";
  title?: string;
};

type Props = {
  rows: BarRow[];
  danger?: boolean;
  /** Narrow layout for tight side columns: no bar track, just name/value/delta rows. */
  compact?: boolean;
  /** Rows beyond this many are paginated instead of all rendered at once. Defaults to 6. */
  pageSize?: number;
  /** When set, each row becomes a clickable filter trigger (hover + active-state highlight) for
   *  whatever downstream panel this list feeds. */
  onRowClick?: (key: string) => void;
  activeKey?: string | null;
};

export function BarRows({ rows, danger = false, compact = false, pageSize = 6, onRowClick, activeKey }: Props) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const clampedPage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [rows.length]);

  if (rows.length === 0) {
    return <p className={css.emptyNote}>Nothing to show yet.</p>;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  const pageRows = rows.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  const pagination =
    totalPages > 1 ? (
      <div className={css.insightPagination}>
        <button type="button" className={css.insightPageBtn} disabled={clampedPage <= 1} onClick={() => setPage(clampedPage - 1)} aria-label="Previous">
          <IconChevronLeft size={14} />
        </button>
        <span className={css.insightPageInfo}>
          {clampedPage} / {totalPages}
        </span>
        <button type="button" className={css.insightPageBtn} disabled={clampedPage >= totalPages} onClick={() => setPage(clampedPage + 1)} aria-label="Next">
          <IconChevronRight size={14} />
        </button>
      </div>
    ) : null;

  if (compact) {
    return (
      <>
        <div className={css.barlistCompact}>
          {pageRows.map((r) => (
            <div
              className={`${css.barrowCompact}${onRowClick ? ` ${css.barrowClickable}` : ""}${activeKey === r.key ? ` ${css.barrowActive}` : ""}`}
              key={r.key}
              role={onRowClick ? "button" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(r.key) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r.key); } } : undefined}
            >
              <span className={css.barname}>{r.label}</span>
              <span className={css.barvalue}>
                {r.valueLabel}
                {r.deltaLabel ? <small className={r.deltaTone === "negative" ? css.deltaDown : css.deltaUp}>{r.deltaLabel}</small> : null}
              </span>
            </div>
          ))}
        </div>
        {pagination}
      </>
    );
  }

  return (
    <>
      <div className={css.barlist}>
        {pageRows.map((r) => {
          const pct = Math.max(4, (r.value / max) * 100);
          return (
            <div
              className={`${css.barrow}${onRowClick ? ` ${css.barrowClickable}` : ""}${activeKey === r.key ? ` ${css.barrowActive}` : ""}`}
              key={r.key}
              role={onRowClick ? "button" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(r.key) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r.key); } } : undefined}
            >
              <div className={css.barlabelcol}>
                <span className={css.barname}>{r.label}</span>
                {r.sublabel ? <span className={css.barsub}>{r.sublabel}</span> : null}
              </div>
              <div className={css.bartrack} data-tooltip={r.title}>
                <div
                  className={`${css.barfill}${danger ? ` ${css.barfillDanger}` : ""}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className={css.barvalue}>
                {r.valueLabel}
                {r.subValue ? <small>{r.subValue}</small> : null}
                {r.deltaLabel ? <small className={r.deltaTone === "negative" ? css.deltaDown : css.deltaUp}>{r.deltaLabel}</small> : null}
              </div>
            </div>
          );
        })}
      </div>
      {pagination}
    </>
  );
}
