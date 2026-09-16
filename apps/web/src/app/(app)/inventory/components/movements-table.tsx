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
import { movementSourceHref, quarantineReasonLabel } from "../utils";

type Props = {
  rows: MovementRow[];
  total: number;
  loading: boolean;
  page: number;
  pageSize: number;
  /** Show the product column (hidden when the list is already one product). */
  showProduct: boolean;
  /** Only meaningful for one product's or batch's unfiltered timeline — the API says when. */
  showBalance: boolean;
  onPageChange: (page: number) => void;
  emptyTitle?: string;
  emptyDescription?: string;
};

function QtyCell({ row }: { row: MovementRow }) {
  if (row.quarantineDelta !== 0) {
    const held = row.quarantineDelta > 0;
    return (
      <span className={css.qtyStack} style={{ alignItems: "flex-start" }}>
        <span className={`${css.heldChip} ${css.heldChipQuarantine}`}>
          {held ? "+" : "−"}
          {Math.abs(row.quarantineDelta)} {held ? "held" : "released"}
        </span>
        <span className={css.qtySecondary}>On hand unchanged</span>
      </span>
    );
  }
  return (
    <span className={row.qtyDelta >= 0 ? detailCss.qtyPositive : detailCss.qtyNegative}>
      {row.qtyDelta >= 0 ? "+" : ""}
      {row.qtyDelta} units
    </span>
  );
}

export function MovementsTable({
  rows,
  total,
  loading,
  page,
  pageSize,
  showProduct,
  showBalance,
  onPageChange,
  emptyTitle = "No stock movements match your filters",
  emptyDescription,
}: Props) {
  const columns: Column<MovementRow>[] = useMemo(() => {
    const cols: Column<MovementRow>[] = [
      {
        key: "occurredAt",
        header: "Date & time",
        width: "150px",
        render: (row) => (
          <span className={detailCss.mutedCell}>{formatMovementDateTime(row.occurredAt)}</span>
        ),
      },
    ];

    if (showProduct) {
      cols.push({
        key: "product",
        header: "Product",
        render: (row) => (
          <Link href={`/inventory?stock=${row.product.id}`} className={css.productName}>
            {row.product.name}
          </Link>
        ),
      });
    }

    cols.push(
      {
        key: "movementType",
        header: "Type",
        width: "150px",
        render: (row) => formatMovementType(row.movementType),
      },
      {
        key: "reference",
        header: "Source",
        render: (row) => {
          const code = quarantineReasonLabel(row.reasonCode);
          const text = formatMovementReference(row.referenceType, row.referenceId, row.reason);
          const href = movementSourceHref(row);
          return (
            <span className={detailCss.mutedCell}>
              {href ? (
                <Link href={href} className={css.productName}>
                  {text}
                </Link>
              ) : (
                text
              )}
              {code && !text.toLowerCase().includes(code.toLowerCase()) ? ` · ${code}` : ""}
            </span>
          );
        },
      },
      {
        key: "batchNo",
        header: "Batch",
        width: "110px",
        render: (row) => row.batchNo ?? "—",
      },
      {
        key: "qtyDelta",
        header: "Qty",
        width: "130px",
        render: (row) => <QtyCell row={row} />,
      },
    );

    if (showBalance) {
      cols.push({
        key: "balance",
        header: "On hand after",
        width: "130px",
        render: (row) => (
          <span className={detailCss.mutedCell}>
            {row.balanceBefore != null && row.balanceAfter != null
              ? `${row.balanceBefore} → ${row.balanceAfter}`
              : "—"}
          </span>
        ),
      });
    }

    cols.push({
      key: "actorName",
      header: "User",
      width: "130px",
      render: (row) => row.actorName ?? "—",
    });

    return cols;
  }, [showProduct, showBalance]);

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
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      emptyIcon={<IconActivity size={48} />}
      compact
      className={css.movementsTable}
      noHorizontalScroll
    />
  );
}
