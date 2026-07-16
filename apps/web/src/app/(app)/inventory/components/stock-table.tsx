"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  IconAlertTriangle,
  IconActivity,
  IconEye,
  IconPackage,
} from "@/components/icons";
import { DataTable, type Column } from "@/components/ui";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { ProductStockBadge } from "../../products/components/product-stock-badge";
import { PAGE_SIZE } from "../constants";
import css from "../inventory.module.css";
import type { StockRow } from "../types";
import { formatRelativeTime } from "../utils";

function RowActions({
  row,
  canWrite,
}: {
  row: StockRow;
  canWrite: boolean;
}) {
  return (
    <div className={css.actionsCell}>
      <Link
        href={`/products/${row.productId}`}
        className={`${css.actionIcon} ${css.actionIconView}`}
        aria-label={`View ${row.product.name}`}
        data-tooltip="View product"
      >
        <IconEye size={17} />
      </Link>
      <Link
        href={`/inventory/batches?productId=${row.productId}`}
        className={`${css.actionIcon} ${css.actionIconBatches}`}
        aria-label={`View batches for ${row.product.name}`}
        data-tooltip="View batches"
      >
        <IconPackage size={16} />
      </Link>
      {canWrite && (
        <Link
          href={`/inventory/adjustments?productId=${row.productId}`}
          className={`${css.actionIcon} ${css.actionIconAdjust}`}
          aria-label={`Adjust stock for ${row.product.name}`}
          data-tooltip="Adjust stock"
        >
          <IconActivity size={17} />
        </Link>
      )}
    </div>
  );
}

type StockTableProps = {
  rows: StockRow[];
  loading: boolean;
  page: number;
  canWrite: boolean;
  onPageChange: (page: number) => void;
};

export function StockTable({
  rows,
  loading,
  page,
  canWrite,
  onPageChange,
}: StockTableProps) {
  const columns: Column<StockRow>[] = useMemo(
    () => [
      {
        key: "product",
        header: "Product",
        getValue: (row) => row.product.name,
        render: (row) => (
          <div className={css.productCell}>
            <img
              src={row.product.imageUrl || PRODUCT_PLACEHOLDER_SRC}
              alt=""
              className={css.thumb}
            />
            <div>
              <Link href={`/products/${row.productId}`} className={css.productName}>
                {row.product.name}
              </Link>
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
        key: "stock",
        header: "Stock",
        width: "190px",
        getValue: (row) => row.qtyOnHand,
        render: (row) => (
          <div className={css.stockCell}>
            <ProductStockBadge
              qtyOnHand={row.qtyOnHand}
              stockStatus={row.stockStatus}
              reorderGap={row.reorderGap}
              reorderLevel={row.product.reorderLevel}
            />
            <span className={css.productMeta}>Reorder at {row.product.reorderLevel}</span>
          </div>
        ),
      },
      {
        key: "batches",
        header: "Batches",
        width: "150px",
        getValue: (row) => row.batchCount,
        render: (row) => (
          <Link
            href={`/inventory/batches?productId=${row.productId}`}
            className={`${css.batchBadge} ${
              row.nearExpiryBatchCount > 0
                ? css.batchBadgeWarning
                : row.batchCount > 0
                  ? css.batchBadgeOk
                  : css.batchBadgeEmpty
            }`}
            aria-label={`View batches for ${row.product.name}`}
          >
            {row.nearExpiryBatchCount > 0 && <IconAlertTriangle size={11} />}
            <span>
              {row.batchCount === 0
                ? "No batches"
                : `${row.batchCount} ${row.batchCount === 1 ? "batch" : "batches"}${
                    row.nearExpiryBatchCount > 0
                      ? ` - ${row.nearExpiryBatchCount} expiring`
                      : ""
                  }`}
            </span>
          </Link>
        ),
      },
      {
        key: "lastMovement",
        header: "Last movement",
        width: "130px",
        getValue: (row) => row.lastMovementAt ?? "",
        render: (row) => <>{formatRelativeTime(row.lastMovementAt)}</>,
      },
      {
        key: "actions",
        header: "Actions",
        width: canWrite ? "116px" : "82px",
        align: "right",
        render: (row) => <RowActions row={row} canWrite={canWrite} />,
      },
    ],
    [canWrite],
  );

  const pageSize = PAGE_SIZE;
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize]);

  return (
    <DataTable<StockRow>
      columns={columns}
      data={paged}
      rowKey={(r) => r.productId}
      loading={loading}
      page={page}
      pageSize={pageSize}
      total={rows.length}
      onPageChange={onPageChange}
      emptyTitle="No stock rows match this view"
      emptyDescription="Try another filter or search"
      emptyIcon={<IconPackage size={48} />}
      compact
      className={css.stockOverviewTable}
      noHorizontalScroll
    />
  );
}
