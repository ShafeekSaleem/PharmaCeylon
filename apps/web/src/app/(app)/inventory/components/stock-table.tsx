"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { IconAlertTriangle, IconPackage } from "@/components/icons";
import { DataTable, RowMenu, type Column, type SortDir } from "@/components/ui";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { ProductStockBadge } from "../../products/components/product-stock-badge";
import { PAGE_SIZE } from "../constants";
import css from "../inventory.module.css";
import type { StockRow } from "../types";
import { formatRelativeTime } from "../utils";
import { HeldChips } from "./batches-table";

export type StockSortKey = "name" | "available" | "onHand";

type StockTableProps = {
  rows: StockRow[];
  loading: boolean;
  page: number;
  total: number;
  sortKey: StockSortKey;
  sortDir: SortDir;
  canAdjust: boolean;
  onSort: (key: StockSortKey, dir: SortDir | null) => void;
  onPageChange: (page: number) => void;
  onOpen: (row: StockRow) => void;
  onAdjust: (row: StockRow) => void;
  emptyTitle?: string;
  emptyDescription?: string;
};

export function StockTable({
  rows,
  loading,
  page,
  total,
  sortKey,
  sortDir,
  canAdjust,
  onSort,
  onPageChange,
  onOpen,
  onAdjust,
  emptyTitle = "No stock rows match this view",
  emptyDescription = "Try another filter or search",
}: StockTableProps) {
  const router = useRouter();

  const columns: Column<StockRow>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Product",
        sortable: true,
        render: (row) => (
          <div className={css.productCell}>
            <img
              src={row.product.imageUrl || PRODUCT_PLACEHOLDER_SRC}
              alt={row.product.imageUrl ? row.product.name : ""}
              aria-hidden={!row.product.imageUrl}
              className={css.thumb}
            />
            <div>
              <button
                type="button"
                className={css.rowTitleButton}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(row);
                }}
              >
                {row.product.name}
              </button>
              <div className={css.productMeta}>
                {row.product.sku}
                {row.product.barcode ? ` · ${row.product.barcode}` : ""}
              </div>
              <div className={css.productMeta}>
                {row.product.genericName || row.product.brandName || row.product.dosageForm || "—"}
                {row.product.isControlled ? " · Controlled" : ""}
              </div>
            </div>
          </div>
        ),
      },
      {
        key: "available",
        header: "Available",
        sortable: true,
        width: "170px",
        render: (row) => (
          <div className={css.stockCell}>
            <ProductStockBadge
              qtyOnHand={row.availableQty}
              stockStatus={row.stockStatus}
              reorderGap={row.reorderGap}
              reorderLevel={row.product.reorderLevel}
            />
            <span className={css.productMeta}>Reorder at {row.product.reorderLevel}</span>
          </div>
        ),
      },
      {
        key: "onHand",
        header: "On hand",
        sortable: true,
        width: "96px",
        align: "right",
        render: (row) => (
          <span className={css.qtyStack}>
            <span className={css.qtyPrimary}>{row.qtyOnHand.toLocaleString()}</span>
          </span>
        ),
      },
      {
        key: "held",
        header: "Held",
        width: "180px",
        render: (row) => (
          <HeldChips
            quarantined={row.quarantinedQty}
            reserved={row.reservedQty}
            expired={row.expiredQty}
          />
        ),
      },
      {
        key: "batches",
        header: "Batches",
        width: "150px",
        render: (row) => (
          <span
            className={`${css.batchBadge} ${
              row.expiredBatchCount > 0 || row.nearExpiryBatchCount > 0
                ? css.batchBadgeWarning
                : row.batchCount > 0
                  ? css.batchBadgeOk
                  : css.batchBadgeEmpty
            }`}
          >
            {(row.expiredBatchCount > 0 || row.nearExpiryBatchCount > 0) && (
              <IconAlertTriangle size={11} />
            )}
            <span>
              {row.batchCount === 0
                ? "No batches"
                : `${row.batchCount} ${row.batchCount === 1 ? "batch" : "batches"}${
                    row.expiredBatchCount > 0
                      ? ` · ${row.expiredBatchCount} expired`
                      : row.nearExpiryBatchCount > 0
                        ? ` · ${row.nearExpiryBatchCount} expiring`
                        : ""
                  }`}
            </span>
          </span>
        ),
      },
      {
        key: "lastMovement",
        header: "Last movement",
        width: "120px",
        render: (row) => <>{formatRelativeTime(row.lastMovementAt)}</>,
      },
      {
        key: "actions",
        header: "",
        width: "56px",
        align: "right",
        render: (row) => (
          <RowMenu
            label={row.product.name}
            actions={[
              { label: "Stock details", onClick: () => onOpen(row) },
              {
                label: "Batches",
                onClick: () => router.push(`/inventory/batches?productId=${row.productId}`),
              },
              {
                label: "Movement history",
                onClick: () => router.push(`/inventory/movements?productId=${row.productId}`),
              },
              ...(canAdjust
                ? [{ label: "Adjust stock", onClick: () => onAdjust(row), separated: true }]
                : []),
            ]}
          />
        ),
      },
    ],
    [canAdjust, onAdjust, onOpen, router],
  );

  return (
    <DataTable<StockRow>
      columns={columns}
      data={rows}
      rowKey={(r) => r.productId}
      loading={loading}
      page={page}
      pageSize={PAGE_SIZE}
      total={total}
      onPageChange={onPageChange}
      sortKey={sortKey === "name" && sortDir === "asc" ? undefined : sortKey}
      sortDir={sortDir}
      onSort={(key, dir) => onSort(key as StockSortKey, dir)}
      onRowClick={onOpen}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      emptyIcon={<IconPackage size={48} />}
      compact
      className={css.stockOverviewTable}
      noHorizontalScroll
    />
  );
}

