"use client";

import { useEffect, type ReactNode } from "react";
import tableStyles from "@/components/ui/data-table.module.css";

type Props = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
};

function getPageRange(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
    pages.add(i);
  }
  return Array.from(pages).sort((a, b) => a - b);
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

export function StocktakeTablePager({ page, pageSize, total, onPageChange }: Props) {
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
    <div className={tableStyles.pagination}>
      <span className={tableStyles.pageInfo}>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className={tableStyles.pageControls}>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={tableStyles.pageBtn}
        >
          ‹ Prev
        </button>
        {renderPageNumbers(page, totalPages, onPageChange)}
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className={tableStyles.pageBtn}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}
