"use client";

import Link from "next/link";
import detailCss from "../product-detail.module.css";
import type { Product, ProductDetail } from "../types";
import { formatCurrency, formatRelativeExpiry } from "../utils/format";
import { ProductStockBadge } from "./product-stock-badge";

type Props = {
  product: Product;
  detail: ProductDetail;
};

export function ProductDetailStockTab({ product, detail }: Props) {
  const hasBranch = detail.qtyOnHand !== null;

  return (
    <>
      <section className={detailCss.section}>
        <h2 className={detailCss.sectionTitle}>Branch stock</h2>
        {!hasBranch ? (
          <div className={detailCss.emptyState}>
            <p className={detailCss.muted}>
              Select a branch from the top bar to view on-hand quantity and batch details.
            </p>
          </div>
        ) : (
          <ProductStockBadge
            qtyOnHand={detail.qtyOnHand}
            stockStatus={detail.stockStatus}
            reorderGap={detail.reorderGap}
            reorderLevel={product.reorderLevel}
            showReorderHint
          />
        )}
      </section>

      <section className={detailCss.section}>
        <div className={detailCss.sectionHead}>
          <h2 className={detailCss.sectionTitle}>Batches at branch</h2>
          {hasBranch && detail.batches.length > 0 && (
            <span className={detailCss.sectionCount}>{detail.batches.length} batch(es)</span>
          )}
        </div>
        {!hasBranch ? (
          <p className={detailCss.muted}>Batch listing requires a selected branch.</p>
        ) : detail.batches.length === 0 ? (
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
            <table className={detailCss.batchTable}>
              <thead>
                <tr>
                  <th>Batch no.</th>
                  <th>Expiry</th>
                  <th>Cost</th>
                  <th>Sell price</th>
                  <th>Received</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {detail.batches.map((b) => {
                  const expiry = formatRelativeExpiry(b.expiryDate);
                  return (
                    <tr key={b.id}>
                      <td className={detailCss.batchNo}>{b.batchNo}</td>
                      <td>
                        <span className={`${detailCss.expiryBadge} ${detailCss[`expiry_${expiry.tone}`]}`}>
                          {expiry.label}
                        </span>
                      </td>
                      <td>{formatCurrency(b.costPrice)}</td>
                      <td>{formatCurrency(b.sellingPrice)}</td>
                      <td className={detailCss.mutedCell}>
                        {new Date(b.receivedAt).toLocaleDateString()}
                      </td>
                      <td>
                        <Link
                          href={`/inventory/batches?productId=${product.id}&batchId=${b.id}`}
                          className={detailCss.tableLink}
                        >
                          Details
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
