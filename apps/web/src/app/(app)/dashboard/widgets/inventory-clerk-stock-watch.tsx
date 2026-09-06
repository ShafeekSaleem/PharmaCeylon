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

export function InventoryClerkStockWatchWidget({
  data,
}: {
  data: DashboardData;
}) {
  const router = useRouter();
  const { lowStockRows } = data;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(
    1,
    Math.ceil(lowStockRows.length / LOW_STOCK_PAGE_SIZE),
  );

  return (
    <DashboardPanel
      title="Stock Watch"
      footerHref="/inventory?view=low"
      footerLabel="View low stock →"
      footerMeta={
        lowStockRows.length > 0 ? `${lowStockRows.length} SKUs` : undefined
      }
    >
      {lowStockRows.length === 0 ? (
        <p className={css.emptyState}>Stock levels look healthy.</p>
      ) : (
        <>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>SKU</th>
                <th>On hand</th>
                <th>Min</th>
                <th>Need</th>
              </tr>
            </thead>
            <tbody>
              {paginate(lowStockRows, page, LOW_STOCK_PAGE_SIZE).map((r) => {
                const need = Math.max(0, r.product.reorderLevel - r.qtyOnHand);
                return (
                  <tr
                    key={r.productId}
                    {...rowLinkProps(router, `/products/${r.productId}`)}
                  >
                    <td>
                      <strong>{r.product.sku}</strong>
                      <div className={css.muted}>{r.product.name}</div>
                    </td>
                    <td>{r.qtyOnHand}</td>
                    <td className={css.muted}>{r.product.reorderLevel}</td>
                    <td>
                      <StatusBadge
                        status={r.qtyOnHand <= 0 ? "failed" : "pending"}
                        label={
                          r.qtyOnHand <= 0
                            ? "OOS"
                            : need > 0
                              ? `+${need}`
                              : "Low"
                        }
                      />
                    </td>
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
            rangeLabel={`${page * LOW_STOCK_PAGE_SIZE + 1}–${Math.min(lowStockRows.length, (page + 1) * LOW_STOCK_PAGE_SIZE)} of ${lowStockRows.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
