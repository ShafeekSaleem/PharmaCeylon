"use client";

import { Fragment } from "react";
import css from "../reports.module.css";

export type DependencyCell = { supplierId: string; supplierName: string; spend: number; dependencyPct: number };
export type DependencyRow = { categoryId: string | null; categoryName: string; totalSpend: number; cells: DependencyCell[] };

type Props = {
  rows: DependencyRow[];
  suppliers: Array<{ supplierId: string; supplierName: string }>;
  formatValue: (n: number) => string;
  /** Clicking a supplier's column header or any of its cells filters the Supplier Spend Detail
   *  table below to just that supplier — same click-to-filter convention as every other chart. */
  onSupplierClick?: (supplierId: string) => void;
  activeSupplierId?: string | null;
};

function colorFor(pct: number): string {
  if (pct <= 0) return "var(--pc-muted-bg)";
  const t = Math.min(1, pct / 100);
  return `color-mix(in srgb, var(--pc-primary) ${Math.round(8 + t * 82)}%, #fff)`;
}

/** Which categories depend heavily on which suppliers — a compact intensity matrix rather than a
 *  second treemap/donut, since the point is cross-referencing two dimensions at once, not just
 *  ranking one. Cell shade = that supplier's share of the category's own spend (not overall spend),
 *  so a small category can still show a stark 100%-dependency cell. */
export function CategorySupplierMatrix({ rows, suppliers, formatValue, onSupplierClick, activeSupplierId }: Props) {
  if (rows.length === 0 || suppliers.length === 0) {
    return <p className={css.emptyNote}>Not enough purchasing activity to build a dependency matrix yet.</p>;
  }

  return (
    <div className={css.depMatrixWrap}>
      <div className={css.depMatrixGrid} style={{ gridTemplateColumns: `9rem repeat(${suppliers.length}, minmax(3.4rem, 1fr))` }}>
        <div className={css.depMatrixCorner} />
        {suppliers.map((s) => (
          <button
            key={s.supplierId}
            type="button"
            className={`${css.depMatrixColHeader}${onSupplierClick ? ` ${css.depMatrixHeaderClickable}` : ""}${activeSupplierId === s.supplierId ? ` ${css.depMatrixHeaderActive}` : ""}`}
            data-tooltip={s.supplierName}
            onClick={onSupplierClick ? () => onSupplierClick(s.supplierId) : undefined}
            disabled={!onSupplierClick}
          >
            {s.supplierName}
          </button>
        ))}
        {rows.map((row) => (
          <Fragment key={row.categoryId ?? "unclassified"}>
            <div className={css.depMatrixRowHeader} data-tooltip={row.categoryName}>
              {row.categoryName}
            </div>
            {suppliers.map((s) => {
              const cell = row.cells.find((c) => c.supplierId === s.supplierId);
              const pct = cell?.dependencyPct ?? 0;
              return (
                <button
                  key={`${row.categoryId ?? "unclassified"}-${s.supplierId}`}
                  type="button"
                  className={`${css.depMatrixCell}${onSupplierClick ? ` ${css.depMatrixCellClickable}` : ""}${activeSupplierId === s.supplierId ? ` ${css.depMatrixCellActive}` : ""}`}
                  style={{ background: colorFor(pct) }}
                  data-tooltip={`${s.supplierName} — ${pct.toFixed(0)}% of ${row.categoryName}'s spend (${formatValue(cell?.spend ?? 0)})`}
                  onClick={onSupplierClick ? () => onSupplierClick(s.supplierId) : undefined}
                  disabled={!onSupplierClick}
                >
                  {pct > 0 ? `${pct.toFixed(0)}%` : "—"}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
