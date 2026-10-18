"use client";

import { useEffect, type ReactNode } from "react";
import tableStyles from "@/components/ui/data-table.module.css";

type Props = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** For narrow spaces (a side pane): the count, then just ‹ › — nothing changes width page to page. */
  compact?: boolean;
};

/**
 * Always seven slots once there are more than seven pages (first, last, the current page and its
 * neighbours, with ellipses filling the gaps), so Prev and Next stay put as the page changes.
 */
function getPageRange(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 4) return [1, 2, 3, 4, 5, total];
  if (current >= total - 3) return [1, total - 4, total - 3, total - 2, total - 1, total];
  return [1, current - 1, current, current + 1, total];
}

function renderPageNumbers(
  current: number,
  total: number,
  onChange: (page: number) => void,
): ReactNode[] {
  const pages: ReactNode[] = [];
  const range = getPageRange(current, total);
  let lastRendered = 0;

  for (const p of range) {
    if (lastRendered && p - lastRendered > 1) {
      pages.push(
        <span key={`e${p}`} className={tableStyles.ellipsis}>
          …
        </span>,
      );
    }
    pages.push(
      <button
        key={p}
        type="button"
        className={`${tableStyles.pageBtn}${p === current ? ` ${tableStyles.pageBtnActive}` : ""}`}
        onClick={() => onChange(p)}
      >
        {p}
      </button>,
    );
    lastRendered = p;
  }
  return pages;
}

export function TablePager({ page, pageSize, total, onPageChange, compact = false }: Props) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));

  // Keep controlled page in range when filters shrink the result set.
  useEffect(() => {
    if (total > 0 && page > totalPages) {
      onPageChange(totalPages);
    } else if (total === 0 && page !== 1) {
      onPageChange(1);
    }
  }, [onPageChange, page, total, totalPages]);

  if (total <= pageSize) return null;

  return (
    <div className={`${tableStyles.pagination}${compact ? ` ${tableStyles.paginationCompact}` : ""}`}>
      <span className={tableStyles.pageInfo}>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className={tableStyles.pageControls}>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={tableStyles.pageBtn}
          aria-label="Previous page"
        >
          {compact ? "‹" : "Prev"}
        </button>
        {!compact && renderPageNumbers(page, totalPages, onPageChange)}
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className={tableStyles.pageBtn}
          aria-label="Next page"
        >
          {compact ? "›" : "Next"}
        </button>
      </div>
    </div>
  );
}
