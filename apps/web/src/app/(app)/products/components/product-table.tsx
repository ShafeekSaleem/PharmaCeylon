"use client";

import { useMemo } from "react";
import { IconAlertTriangle, IconPackage } from "@/components/icons";
import { DataTable, StatusBadge, type Column, type SortDir } from "@/components/ui";
import { PAGE_SIZE } from "../constants";
import css from "../products.module.css";
import type { ColumnKey, Product } from "../types";
import { ProductActions } from "./product-actions";
import { ProductStockBadge } from "./product-stock-badge";
import { ProductThumb } from "./product-thumb";

type ProductTableProps = {
  products: Product[];
  total: number;
  loading: boolean;
  page: number;
  sortBy: string;
  sortDir: SortDir;
  visibleColumns: Set<ColumnKey>;
  canWrite: boolean;
  canDelete?: boolean;
  onPageChange: (page: number) => void;
  onSort: (key: string, dir: SortDir) => void;
  onRowClick: (row: Product) => void;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
};

export function ProductTable({
  products,
  total,
  loading,
  page,
  sortBy,
  sortDir,
  visibleColumns,
  canWrite,
  canDelete = true,
  onPageChange,
  onSort,
  onRowClick,
  onEdit,
  onDelete,
}: ProductTableProps) {
  const allColumnDefs: Column<Product>[] = useMemo(
    () => [
      {
        key: "image",
        header: "",
        width: "48px",
        render: (row) => <ProductThumb row={row} />,
      },
      {
        key: "name",
        header: "Product",
        sortable: true,
        getValue: (row) => row.name,
        render: (row) => (
          <div className={css.productCell}>
            {!visibleColumns.has("image") ? <ProductThumb row={row} /> : null}
            <div className={css.nameCell}>
              <span className={css.productName}>{row.name}</span>
              {row.genericName && row.genericName !== row.name ? (
                <span className={css.genericName}>{row.genericName}</span>
              ) : null}
              {(row.categories?.length ?? 0) > 0 ? (
                <span className={css.tagRow}>
                  {row.categories!.slice(0, 2).map((c) => (
                    <span key={c.id} className={css.metaChip}>
                      {c.name}
                    </span>
                  ))}
                  {(row.categories?.length ?? 0) > 2 ? (
                    <span className={css.metaChip}>+{(row.categories?.length ?? 0) - 2}</span>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        key: "sku",
        header: "SKU",
        sortable: true,
        width: "110px",
        getValue: (row) => row.sku,
      },
      {
        key: "brandName",
        header: "Brand",
        sortable: true,
        getValue: (row) => row.brandName ?? "",
        render: (row) => <>{row.brandName ?? "—"}</>,
      },
      {
        key: "dosageForm",
        header: "Form / Strength",
        getValue: (row) => row.dosageForm ?? "",
        render: (row) => (
          <>
            {row.dosageForm ?? "—"}
            {row.strength ? ` · ${row.strength}` : ""}
          </>
        ),
      },
      {
        key: "manufacturer",
        header: "Manufacturer",
        getValue: (row) => row.manufacturer ?? "",
        render: (row) => <>{row.manufacturer ?? "—"}</>,
      },
      {
        key: "unit",
        header: "Unit",
        width: "80px",
        getValue: (row) => row.unit ?? "",
        render: (row) => <>{row.unit ?? "—"}</>,
      },
      {
        key: "stock",
        header: "Stock",
        align: "left",
        width: "150px",
        render: (row) => (
          <ProductStockBadge
            qtyOnHand={row.qtyOnHand}
            stockStatus={row.stockStatus}
            reorderGap={row.reorderGap}
            reorderLevel={row.reorderLevel}
          />
        ),
      },
      {
        key: "reorderLevel",
        header: "Reorder Lvl",
        align: "right",
        width: "100px",
        sortable: true,
        getValue: (row) => row.reorderLevel,
        render: (row) => <>{row.reorderLevel}</>,
      },
      {
        key: "status",
        header: "Status",
        width: "120px",
        render: (row) => (
          <div className={css.statusCell}>
            <StatusBadge status={row.isActive ? "active" : "inactive"} dot />
            {row.isControlled ? (
              <span className={css.controlledTag}>
                <IconAlertTriangle size={11} />
                Ctrl
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        width: "72px",
        align: "right",
        render: (row) =>
          canWrite ? (
            <ProductActions row={row} canDelete={canDelete} onEdit={onEdit} onDelete={onDelete} />
          ) : null,
      },
    ],
    [canDelete, canWrite, onDelete, onEdit, visibleColumns],
  );

  const columns = useMemo(
    () => allColumnDefs.filter((col) => visibleColumns.has(col.key as ColumnKey)),
    [allColumnDefs, visibleColumns],
  );

  return (
    <DataTable<Product>
      columns={columns}
      data={products}
      rowKey={(r) => r.id}
      loading={loading}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={onPageChange}
      sortKey={sortBy}
      sortDir={sortDir}
      onSort={onSort}
      onRowClick={onRowClick}
      compact
      emptyTitle="No products found"
      emptyDescription="Try adjusting your search or filters"
      emptyIcon={<IconPackage size={42} />}
    />
  );
}
