"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import { rowLinkProps } from "../lib/row-link";
import css from "../dashboard.module.css";

const LOW_STOCK_PAGE_SIZE = 4;

export function PharmacistStockWatchWidget({ data }: { data: DashboardData }) {
  const router = useRouter();
  const { lowStockRows } = data;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(lowStockRows.length / LOW_STOCK_PAGE_SIZE));

  return (
    <DashboardPanel title="Stock Watch — Therapeutic Essentials" footerHref="/inventory?view=low" footerLabel="Open inventory →">
      {lowStockRows.length === 0 ? (
        <p className={css.emptyState}>No low / out-of-stock essentials right now.</p>
      ) : (
        <>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Available</th>
                <th>Min</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {paginate(lowStockRows, page, LOW_STOCK_PAGE_SIZE).map((r) => (
                <tr key={r.productId} {...rowLinkProps(router, `/products/${r.productId}`)}>
                  <td>
                    {r.product.name}
                    {r.product.isControlled ? <span className={css.muted}> · CD</span> : null}
                  </td>
                  <td>{r.qtyOnHand}</td>
                  <td>{r.product.reorderLevel}</td>
                  <td>
                    <StatusBadge
                      status={r.qtyOnHand <= 0 ? "failed" : "pending"}
                      label={r.qtyOnHand <= 0 ? "Out of Stock" : "Low Stock"}
                      variant={r.qtyOnHand <= 0 ? "danger" : "warning"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * LOW_STOCK_PAGE_SIZE + 1}–${Math.min(lowStockRows.length, (page + 1) * LOW_STOCK_PAGE_SIZE)} of ${lowStockRows.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
