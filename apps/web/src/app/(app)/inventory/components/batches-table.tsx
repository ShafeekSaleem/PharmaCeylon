"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconCalendar,
  IconEye,
  IconPackage,
} from "@/components/icons";
import { RoleLink } from "@/components/role-access";
import { DataTable, type Column } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
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
  onChanged?: () => void;
};

function RowActions({
  row,
  canWrite,
  busyId,
  onQuarantine,
  onRelease,
}: {
  row: BatchRow;
  canWrite: boolean;
  busyId: string | null;
  onQuarantine: (row: BatchRow) => void;
  onRelease: (row: BatchRow) => void;
}) {
  const busy = busyId === row.id;
  return (
    <div className={css.actionsCell}>
      <RoleLink
        href={`/products/${row.productId}`}
        className={`${css.actionIcon} ${css.actionIconView}`}
        aria-label={`View ${row.product.name}`}
        data-tooltip="View product"
      >
        <IconEye size={17} />
      </RoleLink>
      <RoleLink
        href={`/inventory/adjustments?productId=${row.productId}&batchId=${row.id}`}
        roles={INVENTORY_WRITE_ROLES}
        className={`${css.actionIcon} ${css.actionIconAdjust}`}
        aria-label={`Adjust ${row.product.name}, batch ${row.batchNo}`}
        data-tooltip="Adjust this batch"
      >
        <IconActivity size={17} />
      </RoleLink>
      {canWrite && !row.isQuarantined && (
        <button
          type="button"
          className={`${css.actionIcon} ${css.actionIconQuarantine}`}
          onClick={() => onQuarantine(row)}
          disabled={busy}
          aria-label={`Quarantine batch ${row.batchNo}`}
          data-tooltip="Quarantine batch"
        >
          <IconAlertTriangle size={17} />
        </button>
      )}
      {canWrite && row.isQuarantined && (
        <button
          type="button"
          className={`${css.actionIcon} ${css.actionIconRelease}`}
          onClick={() => onRelease(row)}
          disabled={busy}
          aria-label={`Release quarantine on batch ${row.batchNo}`}
          data-tooltip="Release quarantine"
        >
          <IconPackage size={17} />
        </button>
      )}
    </div>
  );
}

export function BatchesTable({
  rows,
  loading,
  page,
  canWrite,
  onPageChange,
  onChanged,
}: BatchesTableProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function quarantine(row: BatchRow) {
    const reason = window.prompt(
      `Quarantine reason for ${row.product.name} / ${row.batchNo}:`,
      row.expired ? "Expired" : "",
    );
    if (reason == null) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setActionError("Quarantine reason is required");
      return;
    }
    setBusyId(row.id);
    setActionError(null);
    try {
      await apiJson(`/inventory/batches/${row.id}/quarantine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      });
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Quarantine failed");
    } finally {
      setBusyId(null);
    }
  }

  async function release(row: BatchRow) {
    if (!window.confirm(`Release quarantine on batch ${row.batchNo}?`)) return;
    setBusyId(row.id);
    setActionError(null);
    try {
      await apiJson(`/inventory/batches/${row.id}/release-quarantine`, {
        method: "POST",
      });
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Release failed");
    } finally {
      setBusyId(null);
    }
  }

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
        width: "120px",
        getValue: (row) => row.batchNo,
        render: (row) => (
          <div className={css.batchCell}>
            <span className={css.batchNumber}>{row.batchNo}</span>
            {row.isQuarantined && (
              <span
                className={css.quarantineBadge}
                title={row.quarantineReason ?? "Quarantined"}
              >
                Quarantined
              </span>
            )}
          </div>
        ),
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
      width: canWrite ? "128px" : "96px",
      align: "right",
      render: (row) => (
        <RowActions
          row={row}
          canWrite={canWrite}
          busyId={busyId}
          onQuarantine={(r) => void quarantine(r)}
          onRelease={(r) => void release(r)}
        />
      ),
    });

    return cols;
  }, [canWrite, busyId]);

  const pageSize = PAGE_SIZE;
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize]);

  return (
    <>
      {actionError && (
        <p className={css.tableActionError} role="alert">
          {actionError}
        </p>
      )}
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
    </>
  );
}
