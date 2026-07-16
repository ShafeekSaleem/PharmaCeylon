"use client";

import detailCss from "../product-detail.module.css";
import type { ProductDetail } from "../types";
import { computeMarginPercent, formatCurrency, formatCurrencyRange } from "../utils/format";

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number | null | undefined;
  hint?: string;
}) {
  const display = value === null || value === undefined || value === "" ? "—" : String(value);
  return (
    <div className={detailCss.field}>
      <span className={detailCss.fieldLabel}>{label}</span>
      <span className={detailCss.fieldValue}>{display}</span>
      {hint && <span className={detailCss.fieldHint}>{hint}</span>}
    </div>
  );
}

type Props = {
  detail: ProductDetail;
};

export function ProductDetailPricingTab({ detail }: Props) {
  const { pricing } = detail;
  const hasBranch = detail.qtyOnHand !== null;
  const hasPricing = pricing.batchCount > 0;

  const avgMargin =
    hasPricing && pricing.minSellingPrice && pricing.minCostPrice
      ? computeMarginPercent(pricing.minSellingPrice, pricing.minCostPrice)
      : null;

  const maxMargin =
    hasPricing && pricing.maxSellingPrice && pricing.maxCostPrice
      ? computeMarginPercent(pricing.maxSellingPrice, pricing.maxCostPrice)
      : null;

  const marginHint =
    avgMargin != null && maxMargin != null
      ? avgMargin === maxMargin
        ? `${avgMargin}% margin`
        : `${avgMargin}% – ${maxMargin}% margin`
      : undefined;

  if (!hasBranch) {
    return (
      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Pricing summary</h2>
        <div className={detailCss.emptyState}>
          <p className={detailCss.muted}>
            Select a branch to see selling and cost price ranges from received batches.
          </p>
        </div>
      </section>
    );
  }

  if (!hasPricing) {
    return (
      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Pricing summary</h2>
        <div className={detailCss.emptyState}>
          <p className={detailCss.muted}>No batch pricing recorded at this branch yet.</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Price ranges</h2>
        <div className={detailCss.fieldGrid}>
          <Field
            label="Selling price"
            value={formatCurrencyRange(pricing.minSellingPrice, pricing.maxSellingPrice)}
          />
          <Field
            label="Cost price"
            value={formatCurrencyRange(pricing.minCostPrice, pricing.maxCostPrice)}
          />
          <Field label="Batches priced" value={pricing.batchCount} />
          <Field label="Estimated margin" value={marginHint ?? "—"} hint="Based on min/max batch prices" />
        </div>
      </section>

      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Per-batch prices</h2>
        <div className={detailCss.tableWrap}>
          <table className={detailCss.batchTable}>
            <thead>
              <tr>
                <th>Batch no.</th>
                <th>Cost</th>
                <th>Sell price</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {detail.batches.map((b) => {
                const margin = computeMarginPercent(b.sellingPrice, b.costPrice);
                return (
                  <tr key={b.id}>
                    <td className={detailCss.batchNo}>{b.batchNo}</td>
                    <td>{formatCurrency(b.costPrice)}</td>
                    <td>{formatCurrency(b.sellingPrice)}</td>
                    <td>{margin != null ? `${margin}%` : "—"}</td>
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
