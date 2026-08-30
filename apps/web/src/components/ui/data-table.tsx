"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import styles from "./data-table.module.css";

export type SortDir = "asc" | "desc";

export type Column<T> = {
  key: string;
  header: ReactNode;
  sortable?: boolean;
  width?: string;
  render?: (row: T, index: number) => ReactNode;
  getValue?: (row: T) => string | number | null | undefined;
  align?: "left" | "center" | "right";
};

export type DataTableProps<T> = {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyIcon?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  sortKey?: string;
  sortDir?: SortDir;
  /** When dir is null, clear server sort (restore default browse order). */
  onSort?: (key: string, dir: SortDir | null) => void;
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T) => void;
  /** Extra class(es) applied to a row's `<tr>`, e.g. to flag a critical/flagged row. */
  rowClassName?: (row: T, index: number) => string | undefined;
  compact?: boolean;
  className?: string;
  stickyHeader?: boolean;
  noHorizontalScroll?: boolean;
};

function defaultCompare(a: unknown, b: unknown, dir: SortDir): number {
  const av = a ?? "";
  const bv = b ?? "";
  let cmp = 0;
  if (typeof av === "number" && typeof bv === "number") {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
  }
  return dir === "desc" ? -cmp : cmp;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  loading = false,
  emptyIcon,
  emptyTitle = "No data found",
  emptyDescription,
  sortKey: controlledSortKey,
  sortDir: controlledSortDir,
  onSort,
  page: controlledPage,
  pageSize = 10,
  total: controlledTotal,
  onPageChange,
  onRowClick,
  rowClassName,
  compact = false,
  className,
  stickyHeader = false,
  noHorizontalScroll = false,
}: DataTableProps<T>) {
  const [internalSortKey, setInternalSortKey] = useState<string | undefined>();
  const [internalSortDir, setInternalSortDir] = useState<SortDir>("asc");
  const [internalPage, setInternalPage] = useState(1);

  const isServerSorted = onSort !== undefined;
  const isServerPaged = onPageChange !== undefined;

  const sortKey = isServerSorted ? controlledSortKey : internalSortKey;
  const sortDir = isServerSorted ? (controlledSortDir ?? "asc") : internalSortDir;
  const page = isServerPaged ? (controlledPage ?? 1) : internalPage;
  const total = controlledTotal ?? data.length;

  const handleSort = useCallback(
    (key: string) => {
      // Cycle: inactive → asc → desc → clear (default/browse order)
      let nextDir: SortDir | null = "asc";
      if (sortKey === key) {
        nextDir = sortDir === "asc" ? "desc" : null;
      }
      if (isServerSorted) {
        onSort!(key, nextDir);
      } else if (nextDir == null) {
        setInternalSortKey("");
        setInternalSortDir("asc");
        setInternalPage(1);
      } else {
        setInternalSortKey(key);
        setInternalSortDir(nextDir);
        setInternalPage(1);
      }
    },
    [sortKey, sortDir, isServerSorted, onSort],
  );

  const handlePageChange = useCallback(
    (p: number) => {
      if (isServerPaged) {
        onPageChange!(p);
      } else {
        setInternalPage(p);
      }
    },
    [isServerPaged, onPageChange],
  );

  const sortedData = useMemo(() => {
    if (isServerSorted || !sortKey) return data;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return data;
    const getter = col.getValue ?? ((row: T) => (row as Record<string, unknown>)[col.key]);
    return [...data].sort((a, b) => defaultCompare(getter(a), getter(b), sortDir));
  }, [data, sortKey, sortDir, columns, isServerSorted]);

  const pagedData = useMemo(() => {
    if (isServerPaged) return sortedData;
    const start = (page - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, page, pageSize, isServerPaged]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const showPagination = total > pageSize;

  const tableCls = [
    styles.table,
    compact ? styles.compact : "",
    stickyHeader ? styles.stickyHeader : "",
    onRowClick ? styles.clickable : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  if (loading) {
    return (
      <div className={styles.wrap}>
        <table className={tableCls}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} style={{ width: col.width, textAlign: col.align }}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: pageSize > 5 ? 5 : pageSize }).map((_, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col.key}>
                    <div className={styles.skeleton} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className={styles.empty}>
        {emptyIcon && <div className={styles.emptyIcon}>{emptyIcon}</div>}
        <div className={styles.emptyTitle}>{emptyTitle}</div>
        {emptyDescription && <div className={styles.emptyDesc}>{emptyDescription}</div>}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div
        className={`${styles.scrollArea}${
          noHorizontalScroll ? ` ${styles.noHorizontalScroll}` : ""
        }`}
      >
        <table className={tableCls}>
          <thead>
            <tr>
              {columns.map((col) => {
                const active = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    style={{ width: col.width, textAlign: col.align }}
                    className={col.sortable ? styles.sortable : undefined}
                    onClick={col.sortable ? () => handleSort(col.key) : undefined}
                  >
                    <span className={styles.thInner}>
                      {col.header}
                      {col.sortable && (
                        <span className={`${styles.sortIcon}${active ? ` ${styles.sortActive}` : ""}`}>
                          {active && sortDir === "desc" ? "▼" : "▲"}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pagedData.map((row, i) => (
              <tr
                key={rowKey(row)}
                className={rowClassName?.(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((col) => (
                  <td key={col.key} style={{ textAlign: col.align }}>
                    {col.render
                      ? col.render(row, i)
                      : String((row as Record<string, unknown>)[col.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showPagination && (
        <div className={styles.pagination}>
          <span className={styles.pageInfo}>
            {((page - 1) * pageSize) + 1}–{Math.min(page * pageSize, total)} of {total}
          </span>
          <div className={styles.pageControls}>
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => handlePageChange(page - 1)}
              className={styles.pageBtn}
            >
              Prev
            </button>
            {renderPageNumbers(page, totalPages, handlePageChange)}
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => handlePageChange(page + 1)}
              className={styles.pageBtn}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function renderPageNumbers(
  current: number,
  total: number,
  onChange: (p: number) => void,
): ReactNode[] {
  const pages: ReactNode[] = [];
  const range = getPageRange(current, total);
  let lastRendered = 0;

  for (const p of range) {
    if (lastRendered && p - lastRendered > 1) {
      pages.push(<span key={`e${p}`} className={styles.ellipsis}>…</span>);
    }
    pages.push(
      <button
        key={p}
        type="button"
        className={`${styles.pageBtn}${p === current ? ` ${styles.pageBtnActive}` : ""}`}
        onClick={() => onChange(p)}
      >
        {p}
      </button>,
    );
    lastRendered = p;
  }
  return pages;
}

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
