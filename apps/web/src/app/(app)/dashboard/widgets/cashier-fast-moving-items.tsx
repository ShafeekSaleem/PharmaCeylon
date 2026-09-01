"use client";

import { useState } from "react";
import Link from "next/link";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import css from "../dashboard.module.css";

const FAST_ITEMS_PAGE_SIZE = 6;

export function CashierFastMovingItemsWidget({ data }: { data: DashboardData }) {
  const { topProductsToday } = data;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(topProductsToday.length / FAST_ITEMS_PAGE_SIZE));

  return (
    <DashboardPanel title="Fast Moving Counter Items" compact footerHref="/pos" footerLabel="Open POS →">
      {topProductsToday.length === 0 ? (
        <p className={css.emptyState}>No product velocity yet today.</p>
      ) : (
        <>
          <div className={`${css.productStrip} ${css.productStripWrap}`}>
            {paginate(topProductsToday, page, FAST_ITEMS_PAGE_SIZE).map((p) => (
              <Link key={p.sku} href={`/products/${p.id}`} className={css.productChip}>
                <span className={css.productAvatar} aria-hidden>
                  {p.name.slice(0, 2).toUpperCase()}
                </span>
                <div className={css.productChipBody}>
                  <strong>{p.name}</strong>
                  <span>{p.sku}</span>
                  <em>{p.qty} sold</em>
                </div>
              </Link>
            ))}
          </div>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            rangeLabel={`${page * FAST_ITEMS_PAGE_SIZE + 1}–${Math.min(topProductsToday.length, (page + 1) * FAST_ITEMS_PAGE_SIZE)} of ${topProductsToday.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
