"use client";

import Link from "next/link";
import { useMemo } from "react";
import { IconActivity } from "@/components/icons";
import { DataTable, type Column } from "@/components/ui";
import {
  formatMovementDateTime,
  formatMovementReference,
  formatMovementType,
} from "../../products/utils/format";
import detailCss from "../../products/product-detail.module.css";
import css from "../inventory.module.css";
import type { MovementRow } from "../types";

type Props = {
  rows: MovementRow[];
  total: number;
  loading: boolean;
  page: number;
  pageSize: number;
  productId: string | null;
  onPageChange: (page: number) => void;
  emptyDescription?: string;
};

export function MovementsTable({
  rows,
  total,
  loading,
  page,
  pageSize,
  productId,
  onPageChange,
  emptyDescription,
}: Props) {
  const columns: Column<MovementRow>[] = useMemo(() => {
    const cols: Column<MovementRow>[] = [
      {
        key: "occurredAt",
        header: "Date & time",
        render: (row) => (
          <span className={detailCss.mutedCell}>{formatMovementDateTime(row.occurredAt)}</span>
        ),
      },
    ];

    if (!productId) {
      cols.push({
        key: "product",
        header: "Product",
        getValue: (row) => row.product.name,
        render: (row) => (
          <Link href={`/products/${row.product.id}`} className={css.productName}>
            {row.product.name}
          </Link>
        ),
      });
    }

    const showReason = rows.some((row) => !!row.reason?.trim());

    cols.push(
      {
        key: "movementType",
        header: "Type",
        render: (row) => formatMovementType(row.movementType),
      },
      {
        key: "reference",
        header: "Reference",
        render: (row) => (
          <span className={detailCss.mutedCell}>
            {formatMovementReference(row.referenceType, row.referenceId, row.reason)}
          </span>
        ),
      },
      {
        key: "batchNo",
        header: "Batch",
        render: (row) => row.batchNo ?? "—",
      },
      {
        key: "qtyDelta",
        header: "Qty",
        render: (row) => (
          <span
            className={row.qtyDelta >= 0 ? detailCss.qtyPositive : detailCss.qtyNegative}
          >
            {row.qtyDelta >= 0 ? "+" : ""}
            {row.qtyDelta} units
          </span>
        ),
      },
    );

    if (showReason) {
      cols.push({
        key: "reason",
        header: "Reason",
        render: (row) => (
          <span className={detailCss.mutedCell}>{row.reason?.trim() || "—"}</span>
        ),
      });
    }

    if (productId) {
      cols.push({
        key: "balance",
        header: "Balance",
        render: (row) => (
          <span className={detailCss.mutedCell}>
            {row.balanceBefore != null && row.balanceAfter != null
              ? `${row.balanceBefore} → ${row.balanceAfter} units`
              : "—"}
          </span>
        ),
      });
    }

    cols.push({
      key: "actorName",
      header: "User",
      render: (row) => row.actorName ?? "—",
    });

    return cols;
  }, [productId, rows]);

  return (
    <DataTable<MovementRow>
      columns={columns}
      data={rows}
      rowKey={(r) => r.id}
      loading={loading}
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={onPageChange}
      emptyTitle="No stock movements match your filters"
      emptyDescription={emptyDescription}
      emptyIcon={<IconActivity size={48} />}
      compact
      className={css.movementsTable}
      noHorizontalScroll
    />
  );
}
