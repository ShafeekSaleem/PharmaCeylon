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

function expiryTone(iso: string): "danger" | "warning" | "info" {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "danger";
  if (days <= 30) return "warning";
  return "info";
}

function expiryLabel(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "Expired";
  if (days <= 30) return "Within 30 days";
  if (days <= 90) return "Within 90 days";
  return formatExpiry(iso);
}

export function PharmacistBatchExpiryMonitorWidget({
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
      title="Batch & Expiry Monitor"
      footerHref="/inventory/batches?nearExpiryDays=30"
      footerLabel="View all batches →"
      footerMeta={`${nearExpiryCount} near expiry`}
    >
      {nearExpiryItems.length === 0 ? (
        <p className={css.emptyState}>No batches expiring within 30 days.</p>
      ) : (
        <>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Batch</th>
                <th>Expiry</th>
                <th>Status</th>
                <th>Qty</th>
              </tr>
            </thead>
            <tbody>
              {paginate(nearExpiryItems, page, BATCHES_PAGE_SIZE).map((b) => (
                <tr
                  key={b.batchId}
                  {...rowLinkProps(router, `/products/${b.productId}`)}
                >
                  <td>
                    {b.product.name}
                    {b.product.isControlled ? (
                      <span className={css.muted}> · CD</span>
                    ) : null}
                  </td>
                  <td>{b.batchNo}</td>
                  <td className={css.muted}>{formatExpiry(b.expiryDate)}</td>
                  <td>
                    <StatusBadge
                      status="pending"
                      label={expiryLabel(b.expiryDate)}
                      variant={expiryTone(b.expiryDate)}
                    />
                  </td>
                  <td>{b.qtyOnHand}</td>
                </tr>
              ))}
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
