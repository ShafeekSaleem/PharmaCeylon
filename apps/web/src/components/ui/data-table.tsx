"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
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
  /**
   * Column widths come from the `width` on each column rather than from what happens to be in
   * the rows. Worth turning on for any table whose rows differ a lot in length: with the
   * browser's default `auto` layout a single long product name silently steals width from
   * every other column, so the same table is laid out differently on each page of results.
   * Give every column a `width` except the one that should absorb the leftover space.
   */
  fixedLayout?: boolean;
  className?: string;
  stickyHeader?: boolean;
  noHorizontalScroll?: boolean;
  /**
   * Row selection. Opt-in: pass `selectedKeys` + `onSelectionChange` to get a leading
   * checkbox column whose header toggles every row on the current page. Selection is
   * controlled by the caller so it can survive paging (or deliberately not).
   */
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  /** Rows that cannot be selected (e.g. the caller has no write access to them). */
  isRowSelectable?: (row: T) => boolean;
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
  fixedLayout = false,
  className,
  stickyHeader = false,
  noHorizontalScroll = false,
  selectedKeys,
  onSelectionChange,
  isRowSelectable,
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

  const selectable = selectedKeys !== undefined && onSelectionChange !== undefined;
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

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

  const selectableRows = useMemo(
    () => (selectable ? pagedData.filter((row) => isRowSelectable?.(row) ?? true) : []),
    [selectable, pagedData, isRowSelectable],
  );
  const selectedOnPage = selectable
    ? selectableRows.filter((row) => selectedKeys.has(rowKey(row))).length
    : 0;
  const allOnPageSelected =
    selectableRows.length > 0 && selectedOnPage === selectableRows.length;

  const toggleRow = useCallback(
    (key: string) => {
      if (!selectedKeys || !onSelectionChange) return;
      const next = new Set(selectedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectionChange(next);
    },
    [selectedKeys, onSelectionChange],
  );

  const togglePage = useCallback(() => {
    if (!selectedKeys || !onSelectionChange) return;
    const next = new Set(selectedKeys);
    for (const row of selectableRows) {
      const key = rowKey(row);
      if (allOnPageSelected) next.delete(key);
      else next.add(key);
    }
    onSelectionChange(next);
  }, [selectedKeys, onSelectionChange, selectableRows, allOnPageSelected, rowKey]);

  if (headerCheckboxRef.current) {
    // A partly-selected page reads as neither on nor off.
    headerCheckboxRef.current.indeterminate = selectedOnPage > 0 && !allOnPageSelected;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const showPagination = total > pageSize;

  const tableCls = [
    styles.table,
    fixedLayout ? styles.fixedLayout : "",
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
              {selectable && <th className={styles.selectCell} />}
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
                {selectable && (
                  <td className={styles.selectCell}>
                    <div className={styles.skeleton} />
                  </td>
                )}
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
              {selectable && (
                <th className={styles.selectCell}>
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    className={styles.selectBox}
                    checked={allOnPageSelected}
                    disabled={selectableRows.length === 0}
                    onChange={togglePage}
                    aria-label={
                      allOnPageSelected
                        ? "Clear selection on this page"
                        : "Select all rows on this page"
                    }
                  />
                </th>
              )}
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
                className={
                  [
                    rowClassName?.(row, i),
                    selectable && selectedKeys.has(rowKey(row))
                      ? styles.selectedRow
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
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
                {selectable && (
                  <td
                    className={styles.selectCell}
                    // Ticking a row must never also open it.
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className={styles.selectBox}
                      checked={selectedKeys.has(rowKey(row))}
                      disabled={!(isRowSelectable?.(row) ?? true)}
                      onChange={() => toggleRow(rowKey(row))}
                      aria-label={"Select row " + String(i + 1)}
                    />
                  </td>
                )}
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
