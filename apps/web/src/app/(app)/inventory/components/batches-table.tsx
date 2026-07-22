"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconCalendar,
  IconPackage,
} from "@/components/icons";
import { RoleLink } from "@/components/role-access";
import { DataTable, type Column } from "@/components/ui";
import { INVENTORY_WRITE_ROLES } from "@/lib/role-access";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { PAGE_SIZE } from "../constants";
import css from "../inventory.module.css";
import type { BatchRow } from "../types";
import { daysLabel, formatCostToSell, formatExpiry } from "../utils";

type BatchesTableProps = {
  rows: BatchRow[];
  loading: boolean;
  page: number;
  canWrite: boolean;
  onPageChange: (page: number) => void;
};

export function BatchesTable({
  rows,
  loading,
  page,
  canWrite,
  onPageChange,
}: BatchesTableProps) {
  const columns: Column<BatchRow>[] = useMemo(() => {
    const cols: Column<BatchRow>[] = [
      {
        key: "product",
        header: "Product",
        width: "220px",
        getValue: (row) => row.product.name,
        render: (row) => (
          <div className={`${css.productCell} ${css.batchProductCell}`}>
            <img
              src={row.product.imageUrl || PRODUCT_PLACEHOLDER_SRC}
              alt=""
              className={css.thumb}
            />
            <div>
              <Link href={`/products/${row.productId}`} className={css.productName}>
                {row.product.name}
              </Link>
              <div className={css.productMeta}>{row.product.sku}</div>
            </div>
          </div>
        ),
      },
      {
        key: "batch",
        header: "Batch",
        width: "100px",
        getValue: (row) => row.batchNo,
        render: (row) => <span className={css.batchNumber}>{row.batchNo}</span>,
      },
      {
        key: "expiry",
        header: "Expiry",
        width: "190px",
        getValue: (row) => row.expiryDate,
        render: (row) => (
          <span
            className={`${css.expiryBadge} ${
              row.expired
                ? css.expiryBadgeExpired
                : row.nearExpiry
                  ? css.expiryBadgeNear
                  : css.expiryBadgeOk
            }`}
          >
            {row.expired || row.nearExpiry ? (
              <IconAlertTriangle size={11} />
            ) : (
              <IconCalendar size={11} />
            )}
            <span>
              {formatExpiry(row.expiryDate)} - {daysLabel(row.daysToExpiry)}
            </span>
          </span>
        ),
      },
      {
        key: "qty",
        header: "On hand",
        width: "90px",
        align: "right",
        getValue: (row) => row.qtyOnHand,
        render: (row) => (
          <span
            className={`${css.batchQty} ${
              row.qtyOnHand > 0 ? css.batchQtyAvailable : css.batchQtyEmpty
            }`}
          >
            {row.qtyOnHand} {row.qtyOnHand === 1 ? "unit" : "units"}
          </span>
        ),
      },
      {
        key: "pricing",
        header: "Cost → Sell",
        width: "210px",
        getValue: (row) => Number(row.costPrice),
        render: (row) => {
          const { cost, sell } = formatCostToSell(row.costPrice, row.sellingPrice);
          return (
            <div className={css.priceCell}>
              <span>{cost}</span>
              <span className={css.priceArrow}>→</span>
              <strong>{sell}</strong>
            </div>
          );
        },
      },
    ];

    cols.push({
      key: "actions",
      header: "Actions",
      width: "64px",
      align: "right",
      render: (row) => (
        <div className={css.actionsCell}>
          <RoleLink
            href={`/inventory/adjustments?productId=${row.productId}&batchId=${row.id}`}
            roles={INVENTORY_WRITE_ROLES}
            className={`${css.actionIcon} ${css.actionIconAdjust}`}
            aria-label={`Adjust ${row.product.name}, batch ${row.batchNo}`}
            data-tooltip="Adjust stock"
          >
            <IconActivity size={17} />
          </RoleLink>
        </div>
      ),
    });

    return cols;
  }, []);

  const pageSize = PAGE_SIZE;
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize]);

  return (
    <DataTable<BatchRow>
      columns={columns}
      data={paged}
      rowKey={(r) => r.id}
      loading={loading}
      page={page}
      pageSize={pageSize}
      total={rows.length}
      onPageChange={onPageChange}
      emptyTitle="No batches match your filters"
      emptyDescription="Try another expiry filter or search"
      emptyIcon={<IconPackage size={48} />}
      compact
      className={css.batchInventoryTable}
      noHorizontalScroll
    />
  );
}
