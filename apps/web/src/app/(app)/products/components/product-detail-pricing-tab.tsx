"use client";

import { type ReactNode } from "react";
import {
  IconCheck,
  IconDollarSign,
  IconInfo,
  IconTag,
} from "@/components/icons";
import detailCss from "../product-detail.module.css";
import type { AuditHistoryItem, Product, ProductDetail } from "../types";
import {
  computeMarginPercent,
  formatCurrency,
  formatDateTime,
  historyEventCategory,
} from "../utils/format";

type Props = {
  product: Product;
  detail: ProductDetail;
  branchName: string | null;
};

function PricingKpiTile({
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

function PricingField({ label, value }: { label: string; value: string }) {
  return (
    <div className={detailCss.field}>
      <span className={detailCss.fieldLabel}>{label}</span>
      <span className={detailCss.fieldValue}>{value}</span>
    </div>
  );
}

function latestPriceUpdate(history: AuditHistoryItem[]) {
  return (
    history.find((item) => historyEventCategory(item.eventName, item.payload) === "pricing") ??
    null
  );
}

export function ProductDetailPricingTab({ product, detail, branchName }: Props) {
  const { pricing } = detail;
  const hasBranch = detail.qtyOnHand !== null;
  const hasPricing = pricing.batchCount > 0;
  const summary = detail.branchSummary;

  const sellPrice = summary?.primarySellingPrice ?? pricing.minSellingPrice;
  const costPrice = summary?.primaryCostPrice ?? pricing.minCostPrice;
  const margin =
    summary?.marginPercent ??
    (sellPrice && costPrice ? computeMarginPercent(sellPrice, costPrice) : null);
  const marginAmount =
    sellPrice && costPrice ? Number(sellPrice) - Number(costPrice) : null;
  const taxCategory = product.taxCategory ?? "—";
  const hasActiveBatches = detail.batches.some((b) => b.qtyOnHand > 0);
  const lastPriceEvent = latestPriceUpdate(detail.history);
  const lastPriceUpdateText = lastPriceEvent
    ? `${formatDateTime(lastPriceEvent.createdAt)} by ${lastPriceEvent.actor?.fullName ?? "System"}`
    : formatDateTime(product.updatedAt);

  if (!hasBranch) {
    return (
      <section className={detailCss.section}>
        <div className={detailCss.emptyState}>
          <p className={detailCss.muted}>
            Select a branch to see selling and cost prices from received batches.
          </p>
        </div>
      </section>
    );
  }

  if (!hasPricing) {
    return (
      <section className={detailCss.section}>
        <div className={detailCss.emptyState}>
          <p className={detailCss.muted}>No batch pricing recorded at this branch yet.</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Pricing summary</h2>
        <div className={detailCss.stockKpiRow}>
          <PricingKpiTile
            label="Selling price"
            value={sellPrice ? formatCurrency(sellPrice) : "—"}
            sub="Per unit"
            icon={<IconDollarSign size={14} />}
            tone="primary"
          />
          <PricingKpiTile
            label="Cost price"
            value={costPrice ? formatCurrency(costPrice) : "—"}
            sub="Per unit"
            icon={<IconTag size={14} />}
            tone="info"
          />
          <PricingKpiTile
            label="Gross margin"
            value={margin != null ? `${margin}%` : "—"}
            sub={marginAmount != null ? formatCurrency(marginAmount) : undefined}
            icon={<IconInfo size={14} />}
            tone="success"
          />
          <PricingKpiTile
            label="Tax category"
            value={taxCategory}
            icon={<IconTag size={14} />}
            tone="info"
          />
          <PricingKpiTile
            label="Price status"
            value={hasActiveBatches ? "Active" : "Inactive"}
            sub={`${pricing.batchCount} batch${pricing.batchCount === 1 ? "" : "es"} priced`}
            icon={<IconCheck size={14} />}
            tone={hasActiveBatches ? "success" : "warning"}
          />
        </div>
      </section>

      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Current pricing</h2>
        <div className={detailCss.pricingFieldGrid}>
          <PricingField
            label="Base selling price"
            value={sellPrice ? formatCurrency(sellPrice) : "—"}
          />
          <PricingField label="Cost price" value={costPrice ? formatCurrency(costPrice) : "—"} />
          <PricingField
            label="Margin amount"
            value={marginAmount != null ? formatCurrency(marginAmount) : "—"}
          />
          <PricingField
            label="Margin percent"
            value={margin != null ? `${margin}%` : "—"}
          />
          <PricingField label="Tax" value={taxCategory} />
          <PricingField label="Last price update" value={lastPriceUpdateText} />
        </div>
      </section>

      <section className={detailCss.section}>
        <div className={detailCss.sectionHead}>
          <h2 className={detailCss.sectionTitle}>
            Batch / branch pricing
            {branchName ? ` (${branchName})` : ""}
          </h2>
        </div>
        <div className={detailCss.tableWrap}>
          <table className={`${detailCss.dataTable} ${detailCss.stockTable}`}>
            <thead>
              <tr>
                <th>Batch no.</th>
                <th>Branch</th>
                <th>Cost price</th>
                <th>Sell price</th>
                <th>Margin</th>
                <th>Effective from</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {detail.batches.map((b) => {
                const batchMargin = computeMarginPercent(b.sellingPrice, b.costPrice);
                const marginAmt = Number(b.sellingPrice) - Number(b.costPrice);
                return (
                  <tr key={b.id}>
                    <td>
                      <span className={detailCss.batchNoCell}>
                        {b.batchNo}
                        {b.fefoPriority === 1 && b.qtyOnHand > 0 && (
                          <span className={detailCss.primaryBadge}>Primary</span>
                        )}
                      </span>
                    </td>
                    <td>{branchName ?? "—"}</td>
                    <td className={detailCss.numCell}>{formatCurrency(b.costPrice)}</td>
                    <td className={detailCss.numCell}>{formatCurrency(b.sellingPrice)}</td>
                    <td>
                      {batchMargin != null ? (
                        <>
                          {formatCurrency(marginAmt)}{" "}
                          <span className={detailCss.mutedCell}>({batchMargin}%)</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={detailCss.mutedCell}>{formatDateTime(b.receivedAt)}</td>
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
      </section>
    </>
  );
}
