"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui";
import { formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { PaginationControls } from "../components/pagination-controls";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { paginate } from "../lib/paginate";
import { rowLinkProps } from "../lib/row-link";
import css from "../dashboard.module.css";

const RECENT_SALES_PAGE_SIZE = 6;

export function CashierRecentTransactionsWidget({ data }: { data: DashboardData }) {
  const router = useRouter();
  const { todaySales, todaySalesTotal, todaySalesCount, returnsTodayCount, returnsTodayTotal } = data;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(todaySales.length / RECENT_SALES_PAGE_SIZE));
  const avgBillValue = todaySalesCount > 0 ? todaySalesTotal / todaySalesCount : 0;

  return (
    <DashboardPanel
      title="Recent Transactions"
      compact
      headerRight={
        todaySales.length > 0 || returnsTodayCount > 0 ? (
          <>
            {returnsTodayCount > 0 ? (
              <span className={`${css.monthPill} ${css.monthPill_warning}`}>
                {returnsTodayCount} return{returnsTodayCount === 1 ? "" : "s"} · {formatMoney(returnsTodayTotal)}
              </span>
            ) : null}
            {todaySales.length > 0 ? <span className={css.monthPill}>Avg {formatMoney(avgBillValue)}</span> : null}
          </>
        ) : undefined
      }
      footerHref="/pos"
      footerLabel="Open POS →"
      footerMeta={`${todaySales.length} today`}
    >
      {todaySales.length === 0 ? (
        <p className={css.emptyState}>No transactions yet today.</p>
      ) : (
        <>
          <table className={css.salesTable}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Bill No.</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {paginate(todaySales, page, RECENT_SALES_PAGE_SIZE).map((sale) => (
                <tr key={sale.id} {...rowLinkProps(router, `/pos?invoice=${encodeURIComponent(sale.invoiceNo)}`)}>
                  <td className={css.muted}>{formatRelativeTime(sale.soldAt)}</td>
                  <td>
                    <span className={css.invoiceLink}>{sale.invoiceNo}</span>
                    <div className={css.muted}>{sale.customer?.fullName ?? "Walk-in"}</div>
                  </td>
                  <td>{formatMoney(sale.grandTotal)}</td>
                  <td>
                    <StatusBadge
                      status={sale.status === "refunded" ? "refunded" : "completed"}
                      label={
                        sale.status === "partially_refunded"
                          ? "Partial"
                          : sale.status === "refunded"
                            ? "Refunded"
                            : "Completed"
                      }
                      variant={
                        sale.status === "refunded" || sale.status === "partially_refunded" ? "warning" : "success"
                      }
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
            rangeLabel={`${page * RECENT_SALES_PAGE_SIZE + 1}–${Math.min(todaySales.length, (page + 1) * RECENT_SALES_PAGE_SIZE)} of ${todaySales.length}`}
          />
        </>
      )}
    </DashboardPanel>
  );
}
