"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import {
  IconAlertTriangle,
  IconBox,
  IconCalendar,
  IconPackage,
  IconShoppingCart,
} from "@/components/icons";
import { InventoryFilterSelect } from "../../inventory/components/inventory-filter-select";
import detailCss from "../product-detail.module.css";
import type { Product, ProductDetail } from "../types";
import {
  formatCurrency,
  formatDate,
  formatMovementDateTime,
  formatMovementReference,
  formatMovementType,
  formatRelativeExpiry,
  stockStatusLabel,
} from "../utils/format";

type Props = {
  product: Product;
  detail: ProductDetail;
};

function StockKpiTile({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  tone: "primary" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <div className={detailCss.stockKpiTile}>
      <span className={`${detailCss.stockKpiIcon} ${detailCss[`stockKpiIcon_${tone}`]}`}>
        {icon}
      </span>
      <div className={detailCss.stockKpiBody}>
        <span className={detailCss.stockKpiLabel}>{label}</span>
        <strong className={detailCss.stockKpiValue}>{value}</strong>
        {sub && <span className={detailCss.stockKpiSub}>{sub}</span>}
      </div>
    </div>
  );
}

export function ProductDetailStockTab({ product, detail }: Props) {
  const hasBranch = detail.qtyOnHand !== null;
  const [branchFilter, setBranchFilter] = useState<"all" | "current">("all");

  const branchRows = useMemo(() => {
    if (branchFilter === "current") {
      return detail.branchStock.filter((row) => row.isCurrentBranch);
    }
    return detail.branchStock;
  }, [branchFilter, detail.branchStock]);

  const activeBatches = detail.batches.filter((b) => b.qtyOnHand > 0);
  const available = detail.qtyOnHand ?? 0;
  const nearExpiry = detail.branchSummary?.nearExpiryBatchCount ?? 0;
  const nextExpiryDays = detail.branchSummary?.nextExpiryDays;

  return (
    <>
      {!hasBranch ? (
        <section className={detailCss.section}>
          <div className={detailCss.emptyState}>
            <p className={detailCss.muted}>
              Select a branch from the top bar to view stock overview, batches, and movements.
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className={detailCss.section}>
            <h2 className={detailCss.sectionTitle}>
              Stock overview
              {detail.branchName ? ` (${detail.branchName})` : ""}
            </h2>
            <div className={detailCss.stockKpiRow}>
              <StockKpiTile
                label="On-hand stock"
                value={`${detail.qtyOnHand ?? 0} units`}
                icon={<IconPackage size={14} />}
                tone="success"
              />
              <StockKpiTile
                label="Available"
                value={`${available} units`}
                icon={<IconBox size={14} />}
                tone="success"
              />
              <StockKpiTile
                label="Reorder level"
                value={`${product.reorderLevel} units`}
                icon={<IconShoppingCart size={14} />}
                tone="info"
              />
              <StockKpiTile
                label="Expiring soon"
                value={nearExpiry > 0 ? `${nearExpiry} batch${nearExpiry === 1 ? "" : "es"}` : "0 batches"}
                sub={
                  nearExpiry > 0 && nextExpiryDays != null && nextExpiryDays >= 0
                    ? `${nextExpiryDays} days`
                    : undefined
                }
                icon={<IconCalendar size={14} />}
                tone={nearExpiry > 0 ? "danger" : "info"}
              />
            </div>
          </section>

          <section className={detailCss.section}>
            <div className={detailCss.sectionHead}>
              <h2 className={detailCss.sectionTitle}>Stock by location</h2>
              <div className={detailCss.sectionHeadFilter}>
                <InventoryFilterSelect
                  label="Branch"
                  value={branchFilter}
                  options={[
                    { value: "all", label: "All branches" },
                    { value: "current", label: "This branch only" },
                  ]}
                  onChange={(value) => setBranchFilter(value as "all" | "current")}
                  placeholder="All branches"
                />
              </div>
            </div>
            <div className={detailCss.tableWrap}>
              <table className={`${detailCss.dataTable} ${detailCss.stockTable}`}>
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>On hand</th>
                    <th>Available</th>
                    <th>Reorder level</th>
                    <th>Last movement</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {branchRows.map((row) => (
                    <tr key={row.branchId}>
                      <td>
                        <span className={detailCss.branchNameCell}>
                          {row.branchName}
                          {row.isCurrentBranch && (
                            <span className={detailCss.branchPill}>This branch</span>
                          )}
                        </span>
                      </td>
                      <td className={detailCss.numCell}>{row.qtyOnHand}</td>
                      <td className={detailCss.numCell}>{row.availableQty}</td>
                      <td className={detailCss.numCell}>{row.reorderLevel}</td>
                      <td className={detailCss.movementMetaCell}>
                        <span>{formatMovementDateTime(row.lastMovementAt)}</span>
                        {row.lastMovementType && (
                          <span className={detailCss.movementMetaType}>
                            {formatMovementType(row.lastMovementType)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span
                          className={`${detailCss.statusDot} ${detailCss[`status_${row.stockStatus}`]}`}
                        >
                          {stockStatusLabel(row.stockStatus)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={detailCss.section}>
            <div className={detailCss.sectionHead}>
              <h2 className={detailCss.sectionTitle}>
                Batches at this branch
                {detail.branchName ? ` (${detail.branchName})` : ""}
              </h2>
              <span className={detailCss.sectionCount}>
                {activeBatches.length} active
              </span>
            </div>
            {detail.batches.length === 0 ? (
              <div className={detailCss.emptyState}>
                <p className={detailCss.muted}>No batches received at this branch yet.</p>
                <Link
                  href={`/purchasing?productId=${product.id}&action=create-po`}
                  className={detailCss.inlineLink}
                >
                  Create a purchase order
                </Link>
              </div>
            ) : (
              <div className={detailCss.tableWrap}>
                <table className={`${detailCss.dataTable} ${detailCss.stockTable}`}>
                  <thead>
                    <tr>
                      <th>Batch no.</th>
                      <th>Received date</th>
                      <th>Expiry date</th>
                      <th>Qty</th>
                      <th>Unit cost</th>
                      <th>Sell price</th>
                      <th>FEFO priority</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.batches.map((b) => {
                      const expiry = formatRelativeExpiry(b.expiryDate);
                      return (
                        <tr key={b.id}>
                          <td>
                            <Link
                              href={`/inventory/batches?productId=${product.id}`}
                              className={detailCss.batchNoLink}
                            >
                              {b.batchNo}
                            </Link>
                          </td>
                          <td className={detailCss.mutedCell}>{formatDate(b.receivedAt)}</td>
                          <td>
                            <div className={detailCss.expiryCell}>
                              <span>{formatDate(b.expiryDate)}</span>
                              {(b.nearExpiry || b.expired) && (
                                <span
                                  className={`${detailCss.expirySub} ${detailCss[`expiry_${expiry.tone}`]}`}
                                >
                                  {b.expired && <IconAlertTriangle size={10} />}
                                  {expiry.label}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className={detailCss.numCell}>{b.qtyOnHand}</td>
                          <td>{formatCurrency(b.costPrice)}</td>
                          <td>{formatCurrency(b.sellingPrice)}</td>
                          <td>
                            {b.fefoPriority > 0 ? (
                              <span
                                className={`${detailCss.fefoBadge} ${
                                  b.fefoPriority === 1 ? detailCss.fefoHighest : ""
                                }`}
                              >
                                {b.fefoPriority}
                                {b.fefoPriority === 1 ? " Highest" : ""}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            <span
                              className={`${detailCss.statusDot} ${
                                b.qtyOnHand > 0 ? detailCss.status_ok : detailCss.status_out
                              }`}
                            >
                              {b.qtyOnHand > 0 ? "Active" : "Empty"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={detailCss.section}>
            <div className={detailCss.sectionHead}>
              <h2 className={detailCss.sectionTitle}>
                Recent stock movements
                {detail.branchName ? ` (${detail.branchName})` : ""}
              </h2>
              <Link
                href={`/inventory/movements?productId=${product.id}`}
                className={detailCss.sectionActionBtn}
              >
                View all movements
              </Link>
            </div>
            {detail.movements.length === 0 ? (
              <div className={detailCss.emptyState}>
                <p className={detailCss.muted}>No stock movements recorded yet.</p>
              </div>
            ) : (
              <div className={detailCss.tableWrap}>
                <table className={`${detailCss.dataTable} ${detailCss.stockTable}`}>
                  <thead>
                    <tr>
                      <th>Date &amp; time</th>
                      <th>Type</th>
                      <th>Reference</th>
                      <th>Batch</th>
                      <th>Qty</th>
                      <th>Balance</th>
                      <th>User</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.movements.map((m) => (
                      <tr key={m.id}>
                        <td className={detailCss.mutedCell}>
                          {formatMovementDateTime(m.occurredAt)}
                        </td>
                        <td>{formatMovementType(m.movementType)}</td>
                        <td className={detailCss.mutedCell}>
                          {formatMovementReference(m.referenceType, m.referenceId, m.reason)}
                        </td>
                        <td>{m.batchNo ?? "—"}</td>
                        <td>
                          <span
                            className={
                              m.qtyDelta >= 0 ? detailCss.qtyPositive : detailCss.qtyNegative
                            }
                          >
                            {m.qtyDelta >= 0 ? "+" : ""}
                            {m.qtyDelta} units
                          </span>
                        </td>
                        <td className={detailCss.mutedCell}>
                          {m.balanceBefore} → {m.balanceAfter} units
                        </td>
                        <td>{m.actorName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
