"use client";

import { useState } from "react";
import Link from "next/link";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import css from "../dashboard.module.css";

const PRODUCTS_PAGE_SIZE = 4;

export function ManagerTopProductsTodayWidget({ data }: { data: DashboardData }) {
  const { topProductsToday } = data;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(topProductsToday.length / PRODUCTS_PAGE_SIZE));

  return (
    <DashboardPanel
      title="Top Products Today"
      footerHref="/reports?category=sales&report=product-sales"
      footerLabel="View product sales →"
    >
      {topProductsToday.length === 0 ? (
        <p className={css.emptyState}>No sales recorded yet today.</p>
      ) : (
        <>
          <ul className={css.topProductsList}>
            {paginate(topProductsToday, page, PRODUCTS_PAGE_SIZE).map((p, i) => {
              const rank = page * PRODUCTS_PAGE_SIZE + i;
              return (
                <li key={p.sku}>
                  <Link href={`/products/${p.id}`} className={css.topProductRow}>
                    <span className={`${css.topProductRank}${rank === 0 ? ` ${css.topProductRank_lead}` : ""}`}>
                      {rank + 1}
                    </span>
                    <span className={css.topProductBody}>
                      <strong>{p.name}</strong>
                      <span>{p.sku}</span>
                    </span>
                    <span className={css.topProductQty}>{p.qty} sold</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * PRODUCTS_PAGE_SIZE + 1}–${Math.min(topProductsToday.length, (page + 1) * PRODUCTS_PAGE_SIZE)} of ${topProductsToday.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
