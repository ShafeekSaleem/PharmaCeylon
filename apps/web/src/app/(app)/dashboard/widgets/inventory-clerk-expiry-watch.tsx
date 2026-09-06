"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui";
import { formatExpiry } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import { rowLinkProps } from "../lib/row-link";
import css from "../dashboard.module.css";

const BATCHES_PAGE_SIZE = 4;

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function InventoryClerkExpiryWatchWidget({
  data,
}: {
  data: DashboardData;
}) {
  const router = useRouter();
  const { nearExpiryItems, nearExpiryCount } = data;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(
    1,
    Math.ceil(nearExpiryItems.length / BATCHES_PAGE_SIZE),
  );

  return (
    <DashboardPanel
      title="Expiry Watch"
      footerHref="/inventory/batches?nearExpiryDays=30"
      footerLabel="Open batches →"
      footerMeta={`${nearExpiryCount} near expiry`}
    >
      {nearExpiryItems.length === 0 ? (
        <p className={css.emptyState}>
          No near-expiry batches in the 30-day window.
        </p>
      ) : (
        <>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Product</th>
                <th>Batch</th>
                <th>Expiry</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {paginate(nearExpiryItems, page, BATCHES_PAGE_SIZE).map((b) => {
                const days = daysUntil(b.expiryDate);
                const tone =
                  days < 0 ? "danger" : days <= 14 ? "warning" : "info";
                return (
                  <tr
                    key={b.batchId}
                    {...rowLinkProps(router, `/products/${b.productId}`)}
                  >
                    <td>
                      <strong>{b.product.name}</strong>
                      <div className={css.muted}>{b.product.sku}</div>
                    </td>
                    <td className={css.muted}>{b.batchNo}</td>
                    <td>
                      <StatusBadge
                        status={days < 0 ? "failed" : "pending"}
                        label={
                          days < 0 ? "Expired" : formatExpiry(b.expiryDate)
                        }
                        variant={tone === "info" ? "muted" : tone}
                      />
                    </td>
                    <td>{b.qtyOnHand}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * BATCHES_PAGE_SIZE + 1}–${Math.min(nearExpiryItems.length, (page + 1) * BATCHES_PAGE_SIZE)} of ${nearExpiryItems.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
