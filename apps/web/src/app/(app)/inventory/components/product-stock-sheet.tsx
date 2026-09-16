"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, RowMenu, type RowMenuAction } from "@/components/ui";
import { ProductStockBadge } from "../../products/components/product-stock-badge";
import { formatMovementDateTime, formatMovementType } from "../../products/utils/format";
import type { InventoryAccess } from "../hooks/use-inventory-access";
import { useProductStock } from "../hooks/use-product-stock";
import css from "../inventory.module.css";
import type { BatchRow } from "../types";
import { daysLabel, formatExpiry, formatMoney, formatUnits, movementSourceHref } from "../utils";
import { HeldChips } from "./batches-table";
import {
  QuarantineDialog,
  quarantineTargetFromBatch,
  ReleaseDialog,
  type QuarantineTarget,
} from "./quarantine-dialogs";

type Props = {
  productId: string | null;
  access: InventoryAccess;
  onClose: () => void;
  onAdjust: (productId: string, batchId?: string) => void;
  /** Something changed stock; the list behind the sheet should refresh. */
  onChanged: (message: string) => void;
};

/**
 * Everything about one product's stock at the branch, next to the list it was opened from:
 * where the units are (available, held, promised), which batches hold them, what is on its
 * way in, and what the other branches have.
 */
export function ProductStockSheet({ productId, access, onClose, onAdjust, onChanged }: Props) {
  const { detail, loading, error, reload } = useProductStock(productId);
  const [quarantineTarget, setQuarantineTarget] = useState<QuarantineTarget | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<QuarantineTarget | null>(null);

  const done = (message: string) => {
    setQuarantineTarget(null);
    setReleaseTarget(null);
    void reload();
    onChanged(message);
  };

  const batchActions = (batch: BatchRow): RowMenuAction[] => {
    const holdable = Math.max(0, batch.qtyOnHand - batch.quarantinedQty - batch.reservedQty);
    const actions: RowMenuAction[] = [];
    if (access.canAdjustIn || access.canWriteOff) {
      actions.push({ label: "Adjust stock", onClick: () => onAdjust(batch.productId, batch.id) });
    }
    if (access.canQuarantine) {
      actions.push({
        label: "Quarantine units",
        disabled: holdable <= 0,
        hint: holdable <= 0 ? "Nothing left to hold on this batch" : undefined,
        onClick: () => setQuarantineTarget(quarantineTargetFromBatch(batch)),
      });
    }
    if (access.canRelease && batch.quarantinedQty > 0) {
      actions.push({
        label: "Release from quarantine",
        disabled: batch.expired,
        hint: batch.expired ? "Expired stock can't go back on sale" : undefined,
        onClick: () => setReleaseTarget(quarantineTargetFromBatch(batch)),
      });
    }
    return actions;
  };

  const product = detail?.product;
  const totals = detail?.totals;

  return (
    <>
      <Modal
        open={!!productId}
        onClose={onClose}
        variant="sheet"
        size="lg"
        title={product?.name ?? "Stock details"}
        description={
          product
            ? [product.sku, product.strength, product.dosageForm].filter(Boolean).join(" · ")
            : undefined
        }
        footer={
          productId ? (
            <div className={css.sheetFooter}>
              <span className={css.sheetFooterLinks}>
                <Link
                  href={`/inventory/movements?productId=${productId}`}
                  className={css.sheetFooterLink}
                >
                  Movement history
                </Link>
                <Link href={`/products/${productId}`} className={css.sheetFooterLink}>
                  Product record
                </Link>
              </span>
              {(access.canAdjustIn || access.canWriteOff) && (
                <ModalButton onClick={() => onAdjust(productId)}>Adjust stock</ModalButton>
              )}
              <ModalButton variant="primary" onClick={onClose}>
                Done
              </ModalButton>
            </div>
          ) : undefined
        }
      >
        {error && (
          <Alert variant="error">
            {error}{" "}
            <button type="button" className={css.rowTitleButton} onClick={() => void reload()}>
              Try again
            </button>
          </Alert>
        )}

        {loading && !detail && <p className={css.sheetEmpty}>Loading stock…</p>}

        {detail && product && totals && (
          <>
            <div className={css.sheetHeader}>
              <ProductStockBadge
                qtyOnHand={totals.available}
                stockStatus={detail.stockStatus}
                reorderLevel={product.reorderLevel}
              />
              <span className={css.productMeta}>
                Reorder at {product.reorderLevel}
                {product.isControlled ? " · Controlled" : ""}
              </span>
            </div>

            <div className={css.sheetTotals} role="group" aria-label="Stock totals">
              <div className={`${css.sheetTotal} ${css.sheetTotalPrimary}`}>
                <span className={css.sheetTotalLabel}>Available</span>
                <span className={css.sheetTotalValue}>{totals.available.toLocaleString()}</span>
              </div>
              <div className={css.sheetTotal}>
                <span className={css.sheetTotalLabel}>On hand</span>
                <span className={css.sheetTotalValue}>{totals.onHand.toLocaleString()}</span>
              </div>
              <div className={css.sheetTotal}>
                <span className={css.sheetTotalLabel}>Quarantined</span>
                <span className={css.sheetTotalValue}>{totals.quarantined.toLocaleString()}</span>
              </div>
              <div className={css.sheetTotal}>
                <span className={css.sheetTotalLabel}>Reserved</span>
                <span className={css.sheetTotalValue}>{totals.reserved.toLocaleString()}</span>
              </div>
              <div className={css.sheetTotal}>
                <span className={css.sheetTotalLabel}>Incoming</span>
                <span className={css.sheetTotalValue}>{totals.incoming.toLocaleString()}</span>
              </div>
              <div className={css.sheetTotal}>
                <span className={css.sheetTotalLabel}>On order</span>
                <span className={css.sheetTotalValue}>{totals.onOrder.toLocaleString()}</span>
              </div>
            </div>

            {totals.expired > 0 && (
              <Alert variant="warning">
                {formatUnits(totals.expired)} past expiry {totals.expired === 1 ? "is" : "are"} still
                counted as sellable stock. Quarantine {totals.expired === 1 ? "it" : "them"} so they
                can be written off or returned.
              </Alert>
            )}

            <section className={css.sheetSection} aria-label="Batches">
              <h3 className={css.sheetSectionTitle}>Batches</h3>
              {detail.batches.length === 0 ? (
                <p className={css.sheetEmpty}>No stock at this branch.</p>
              ) : (
                <ul className={css.sheetList}>
                  {detail.batches.map((batch) => {
                    const actions = batchActions(batch);
                    return (
                      <li key={batch.id} className={css.sheetListRow}>
                        <span className={css.sheetListMain}>
                          <strong>{batch.batchNo}</strong>
                          <span className={css.productMeta}>
                            {batch.needsExpiryReview
                              ? "Expiry date to confirm"
                              : `${formatExpiry(batch.expiryDate)} · ${daysLabel(batch.daysToExpiry)}`}
                            {access.canViewCost && batch.costPrice != null
                              ? ` · cost ${formatMoney(batch.costPrice)}`
                              : ""}
                          </span>
                          <HeldChips
                            hideWhenEmpty
                            quarantined={batch.quarantinedQty}
                            reserved={batch.reservedQty}
                            expired={
                              batch.expired
                                ? Math.max(0, batch.qtyOnHand - batch.quarantinedQty - batch.reservedQty)
                                : 0
                            }
                          />
                        </span>
                        <span className={css.sheetListAside}>
                          <span className={css.qtyStack}>
                            <span className={css.qtyPrimary}>{batch.availableQty}</span>
                            <span className={css.qtySecondary}>of {batch.qtyOnHand}</span>
                          </span>
                          {actions.length > 0 && (
                            <RowMenu label={`batch ${batch.batchNo}`} actions={actions} />
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {detail.reservations.length > 0 && (
              <section className={css.sheetSection} aria-label="Reserved for">
                <h3 className={css.sheetSectionTitle}>Reserved for</h3>
                <ul className={css.sheetList}>
                  {detail.reservations.map((r) => (
                    <li key={`${r.sourceId}-${r.batchNo}`} className={css.sheetListRow}>
                      <span className={css.sheetListMain}>
                        <Link href={`/transfers?transfer=${r.sourceId}`} className={css.productName}>
                          {r.label}
                        </Link>
                        <span className={css.productMeta}>Batch {r.batchNo ?? "—"}</span>
                      </span>
                      <span className={css.qtyPrimary}>{formatUnits(r.qty)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(detail.incoming.length > 0 || detail.onOrder.length > 0) && (
              <section className={css.sheetSection} aria-label="On the way">
                <h3 className={css.sheetSectionTitle}>On the way</h3>
                <ul className={css.sheetList}>
                  {detail.incoming.map((row) => (
                    <li key={row.transferId} className={css.sheetListRow}>
                      <span className={css.sheetListMain}>
                        <Link href={`/transfers?transfer=${row.transferId}`} className={css.productName}>
                          {row.transferNumber}
                        </Link>
                        <span className={css.productMeta}>
                          Transfer from {row.fromBranch.name}
                          {row.expectedOn ? ` · expected ${formatExpiry(row.expectedOn)}` : ""}
                        </span>
                      </span>
                      <span className={css.qtyPrimary}>{formatUnits(row.qty)}</span>
                    </li>
                  ))}
                  {detail.onOrder.map((row) => (
                    <li key={row.purchaseOrderId} className={css.sheetListRow}>
                      <span className={css.sheetListMain}>
                        <Link href={`/purchasing?po=${row.purchaseOrderId}`} className={css.productName}>
                          {row.poNumber}
                        </Link>
                        <span className={css.productMeta}>
                          Ordered from {row.supplier.name}
                          {row.expectedOn ? ` · expected ${formatExpiry(row.expectedOn)}` : ""}
                        </span>
                      </span>
                      <span className={css.qtyPrimary}>{formatUnits(row.qty)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.otherBranches.length > 0 && (
              <section className={css.sheetSection} aria-label="Other branches">
                <h3 className={css.sheetSectionTitle}>Other branches</h3>
                <ul className={css.sheetList}>
                  {detail.otherBranches.map((branch) => (
                    <li key={branch.branchId} className={css.sheetListRow}>
                      <span className={css.sheetListMain}>
                        <strong>{branch.name}</strong>
                        <span className={css.productMeta}>{branch.code}</span>
                      </span>
                      <span className={css.qtyStack}>
                        <span className={css.qtyPrimary}>{branch.available} available</span>
                        <span className={css.qtySecondary}>of {branch.onHand} on hand</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className={css.sheetSection} aria-label="Recent movements">
              <h3 className={css.sheetSectionTitle}>Recent movements</h3>
              {detail.recentMovements.length === 0 ? (
                <p className={css.sheetEmpty}>Nothing has moved at this branch yet.</p>
              ) : (
                <ul className={css.sheetList}>
                  {detail.recentMovements.map((m) => {
                    const href = movementSourceHref(m);
                    const label = formatMovementType(m.movementType);
                    return (
                      <li key={m.id} className={css.sheetListRow}>
                        <span className={css.sheetListMain}>
                          {href ? (
                            <Link href={href} className={css.productName}>
                              {label}
                            </Link>
                          ) : (
                            <strong>{label}</strong>
                          )}
                          <span className={css.productMeta}>
                            {formatMovementDateTime(m.occurredAt)}
                            {m.batchNo ? ` · ${m.batchNo}` : ""}
                            {m.actorName ? ` · ${m.actorName}` : ""}
                          </span>
                        </span>
                        <span className={css.qtyPrimary}>
                          {m.quarantineDelta !== 0
                            ? `${m.quarantineDelta > 0 ? "+" : ""}${m.quarantineDelta} held`
                            : `${m.qtyDelta > 0 ? "+" : ""}${m.qtyDelta}`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </Modal>

      <QuarantineDialog target={quarantineTarget} onClose={() => setQuarantineTarget(null)} onDone={done} />
      <ReleaseDialog target={releaseTarget} onClose={() => setReleaseTarget(null)} onDone={done} />
    </>
  );
}
