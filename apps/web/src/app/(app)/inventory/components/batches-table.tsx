"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { IconAlertTriangle, IconCalendar, IconPackage } from "@/components/icons";
import { Alert } from "@/components/alert";
import {
  DataTable,
  FormField,
  Modal,
  RowMenu,
  type Column,
  type RowMenuAction,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { PRODUCT_PLACEHOLDER_SRC } from "@/lib/product-placeholder";
import { PAGE_SIZE } from "../constants";
import type { InventoryAccess } from "../hooks/use-inventory-access";
import css from "../inventory.module.css";
import type { BatchRow } from "../types";
import { daysLabel, formatExpiry, formatMoney, formatUnits } from "../utils";
import {
  QuarantineDialog,
  quarantineTargetFromBatch,
  ReleaseDialog,
  type QuarantineTarget,
} from "./quarantine-dialogs";

type BatchesTableProps = {
  rows: BatchRow[];
  loading: boolean;
  page: number;
  access: Pick<
    InventoryAccess,
    "canAdjustIn" | "canWriteOff" | "canQuarantine" | "canRelease" | "canViewCost"
  >;
  onPageChange: (page: number) => void;
  /** Called after a change on a batch, with a sentence describing what happened. */
  onChanged?: (message?: string) => void;
  onAdjust: (row: BatchRow) => void;
  /** Opens the product's stock sheet. */
  onOpenProduct?: (productId: string) => void;
};

/** Held and promised units, shown only when there are any. */
export function HeldChips({
  quarantined,
  reserved,
  expired = 0,
  hideWhenEmpty = false,
}: {
  quarantined: number;
  reserved: number;
  expired?: number;
  /** In a list line (the stock sheet) an empty dash is noise; in a table cell it marks "none". */
  hideWhenEmpty?: boolean;
}) {
  if (quarantined <= 0 && reserved <= 0 && expired <= 0) {
    return hideWhenEmpty ? null : <span className={css.productMeta}>—</span>;
  }
  return (
    <span className={css.heldChips}>
      {expired > 0 && (
        <span
          className={`${css.heldChip} ${css.heldChipExpired}`}
          data-tooltip="Past expiry and still sellable — quarantine or write these off"
        >
          {expired} expired
        </span>
      )}
      {quarantined > 0 && (
        <span
          className={`${css.heldChip} ${css.heldChipQuarantine}`}
          data-tooltip="Held back from sale and transfer"
        >
          {quarantined} quarantined
        </span>
      )}
      {reserved > 0 && (
        <span
          className={`${css.heldChip} ${css.heldChipReserved}`}
          data-tooltip="Promised to an approved transfer that hasn't shipped"
        >
          {reserved} reserved
        </span>
      )}
    </span>
  );
}

export function BatchesTable({
  rows,
  loading,
  page,
  access,
  onPageChange,
  onChanged,
  onAdjust,
  onOpenProduct,
}: BatchesTableProps) {
  const router = useRouter();
  const [expiryBatch, setExpiryBatch] = useState<BatchRow | null>(null);
  const [expiryDate, setExpiryDate] = useState("");
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [expiryBusy, setExpiryBusy] = useState(false);
  const [quarantineTarget, setQuarantineTarget] = useState<QuarantineTarget | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<QuarantineTarget | null>(null);

  async function confirmExpiry() {
    if (!expiryBatch || !expiryDate) return;
    setExpiryBusy(true);
    setExpiryError(null);
    try {
      await apiJson(`/inventory/batches/${expiryBatch.id}/confirm-expiry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryDate }),
      });
      setExpiryBatch(null);
      onChanged?.(`Expiry date confirmed for batch ${expiryBatch.batchNo}.`);
    } catch (err) {
      setExpiryError(err instanceof Error ? err.message : "Unable to confirm expiry");
    } finally {
      setExpiryBusy(false);
    }
  }

  const columns: Column<BatchRow>[] = useMemo(() => {
    const menuFor = (row: BatchRow): RowMenuAction[] => {
      const holdable = Math.max(0, row.qtyOnHand - row.quarantinedQty - row.reservedQty);
      const actions: RowMenuAction[] = [];
      if (onOpenProduct) {
        actions.push({ label: "Stock details", onClick: () => onOpenProduct(row.productId) });
      }
      actions.push({
        label: "Movement history",
        onClick: () => {
          router.push(`/inventory/movements?batchId=${row.id}&productId=${row.productId}`);
        },
      });
      if (access.canAdjustIn || access.canWriteOff) {
        actions.push({ label: "Adjust stock", onClick: () => onAdjust(row) });
      }
      if (access.canAdjustIn && row.needsExpiryReview) {
        actions.push({
          label: "Confirm expiry date",
          onClick: () => {
            setExpiryBatch(row);
            setExpiryDate("");
            setExpiryError(null);
          },
        });
      }
      if (access.canQuarantine) {
        actions.push({
          label: "Quarantine units",
          separated: true,
          disabled: holdable <= 0,
          hint: holdable <= 0 ? "Nothing left to hold on this batch" : undefined,
          onClick: () => setQuarantineTarget(quarantineTargetFromBatch(row)),
        });
      }
      if (access.canRelease && row.quarantinedQty > 0) {
        actions.push({
          label: "Release from quarantine",
          disabled: row.expired,
          hint: row.expired ? "Expired stock can't go back on sale" : undefined,
          onClick: () => setReleaseTarget(quarantineTargetFromBatch(row)),
        });
      }
      return actions;
    };

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
              alt={row.product.imageUrl ? row.product.name : ""}
              aria-hidden={!row.product.imageUrl}
              className={css.thumb}
            />
            <div>
              {onOpenProduct ? (
                <button
                  type="button"
                  className={css.rowTitleButton}
                  onClick={() => onOpenProduct(row.productId)}
                >
                  {row.product.name}
                </button>
              ) : (
                <Link href={`/products/${row.productId}`} className={css.productName}>
                  {row.product.name}
                </Link>
              )}
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
              <span className={css.quarantineBadge} data-tooltip={row.quarantineReason ?? "Quarantined"}>
                All held
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
        render: (row) =>
          // An imported batch with no expiry carries a far-future placeholder. Printing it as
          // "Dec 31, 2099 - 26782d left" states a date nobody entered as if it were a fact.
          row.needsExpiryReview ? (
            <span
              className={`${css.expiryBadge} ${css.expiryBadgeUnset}`}
              data-tooltip="Imported without an expiry date — confirm the real one before selling"
            >
              <IconCalendar size={11} />
              <span>No expiry date</span>
            </span>
          ) : (
            <span
              className={`${css.expiryBadge} ${
                row.expired
                  ? css.expiryBadgeExpired
                  : row.nearExpiry
                    ? css.expiryBadgeNear
                    : css.expiryBadgeOk
              }`}
            >
              {row.expired || row.nearExpiry ? <IconAlertTriangle size={11} /> : <IconCalendar size={11} />}
              <span>
                {formatExpiry(row.expiryDate)} - {daysLabel(row.daysToExpiry)}
              </span>
            </span>
          ),
      },
      {
        key: "available",
        header: "Available",
        width: "110px",
        align: "right",
        getValue: (row) => row.availableQty,
        render: (row) => (
          <span className={css.qtyStack}>
            <span className={css.qtyPrimary}>{row.availableQty.toLocaleString()}</span>
            <span className={css.qtySecondary}>of {formatUnits(row.qtyOnHand)} on hand</span>
          </span>
        ),
      },
      {
        key: "held",
        header: "Held",
        width: "170px",
        render: (row) => (
          <HeldChips
            quarantined={row.quarantinedQty}
            reserved={row.reservedQty}
            expired={
              row.expired ? Math.max(0, row.qtyOnHand - row.quarantinedQty - row.reservedQty) : 0
            }
          />
        ),
      },
      {
        key: "pricing",
        header: access.canViewCost ? "Cost → Sell" : "Selling price",
        width: access.canViewCost ? "200px" : "120px",
        getValue: (row) => Number(row.sellingPrice),
        render: (row) =>
          access.canViewCost && row.costPrice != null ? (
            <div className={css.priceCell}>
              <span>{formatMoney(row.costPrice)}</span>
              <span className={css.priceArrow}>→</span>
              <strong>{formatMoney(row.sellingPrice)}</strong>
            </div>
          ) : (
            <div className={css.priceCell}>
              <strong>{formatMoney(row.sellingPrice)}</strong>
            </div>
          ),
      },
      {
        key: "supplier",
        header: "Supplier",
        width: "140px",
        getValue: (row) => row.supplier?.name ?? "",
        render: (row) => (
          <span className={css.productMeta} data-tooltip={row.supplier?.name}>
            {row.supplier?.name ?? "—"}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        width: "56px",
        align: "right",
        render: (row) => (
          <RowMenu label={`batch ${row.batchNo}`} actions={menuFor(row)} />
        ),
      },
    ];
    return cols;
  }, [access, onAdjust, onOpenProduct, router]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return rows.slice(start, start + PAGE_SIZE);
  }, [rows, page]);

  return (
    <>
      <Modal
        open={!!expiryBatch}
        onClose={() => setExpiryBatch(null)}
        canDismiss={!expiryBusy}
        title="Confirm batch expiry"
        size="sm"
        description={`${expiryBatch?.product.name ?? ""} · ${expiryBatch?.batchNo ?? ""}`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirmExpiry();
          }}
        >
          <FormField
            label="Actual expiry date"
            type="date"
            value={expiryDate}
            required
            onChange={(event) => setExpiryDate(event.target.value)}
            hint="Read the date from the physical batch. An expired batch will remain blocked from sales."
          />
          {expiryError && <Alert variant="error">{expiryError}</Alert>}
          <button
            type="submit"
            className={css.confirmExpiryButton}
            disabled={!expiryDate || expiryBusy}
          >
            {expiryBusy ? "Saving…" : "Confirm expiry"}
          </button>
        </form>
      </Modal>
      <QuarantineDialog
        target={quarantineTarget}
        onClose={() => setQuarantineTarget(null)}
        onDone={(message) => {
          setQuarantineTarget(null);
          onChanged?.(message);
        }}
      />
      <ReleaseDialog
        target={releaseTarget}
        onClose={() => setReleaseTarget(null)}
        onDone={(message) => {
          setReleaseTarget(null);
          onChanged?.(message);
        }}
      />
      <DataTable<BatchRow>
        columns={columns}
        data={paged}
        rowKey={(r) => r.id}
        loading={loading}
        page={page}
        pageSize={PAGE_SIZE}
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
