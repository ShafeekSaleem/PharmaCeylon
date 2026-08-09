"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  IconBarcodeScan,
  IconPause,
  IconReceipt,
  IconRotateCcw,
  IconSearch,
  IconUsers,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { POS_ROLES, RETURNS_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleDonutChart, SimpleLineChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { CASHIER_AI_INSIGHTS, PLACEHOLDER_CASHIER_QUEUE } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

type Props = { data: DashboardData };

function paymentLabel(method: string | undefined): string {
  if (!method) return "—";
  return method.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function CashierDashboard({ data }: Props) {
  const {
    loading,
    todaySalesTotal,
    todaySalesCount,
    salesTrendLabel,
    salesTrendPositive,
    holdCount,
    holdValue,
    holds,
    pharmacistHolds,
    returnsTodayCount,
    returnsTodayTotal,
    hourlyToday,
    paymentMix,
    paymentMixIsPlaceholder,
    recentSales,
    topProductsToday,
    lowStockRows,
  } = data;

  const rxWaiting = pharmacistHolds.length;
  const peakHour = hourlyToday.reduce(
    (best, p) => (p.value > best.value ? p : best),
    hourlyToday[0] ?? { label: "—", value: 0 },
  );

  const tickerItems: TickerItem[] = useMemo(() => {
    const items: TickerItem[] = [];
    if (rxWaiting > 0) {
      items.push({
        key: "rx",
        count: rxWaiting,
        label: "prescription items waiting verification",
        tone: "danger",
        href: "/pos",
      });
    }
    if (holdCount > 5) {
      items.push({
        key: "holds",
        count: holdCount,
        label: "held sales backlog at counter",
        tone: "warning",
        href: "/pos",
      });
    }
    if (lowStockRows.length > 0) {
      items.push({
        key: "low",
        count: lowStockRows.length,
        label: "items low on stock at counter",
        tone: "warning",
        href: "/inventory?view=low",
      });
    }
    if (returnsTodayCount > 0) {
      items.push({
        key: "ret",
        count: returnsTodayCount,
        label: `returns today · ${formatMoney(returnsTodayTotal)}`,
        tone: "info",
        href: "/returns",
      });
    }
    return items;
  }, [rxWaiting, holdCount, lowStockRows.length, returnsTodayCount, returnsTodayTotal]);

  return (
    <>
      <HeroBand
        label="Shift Sales"
        value={formatMoney(todaySalesTotal)}
        scope="This shift · vs yesterday"
        loading={loading}
        sparkline={hourlyToday}
        trend={
          salesTrendLabel
            ? { label: salesTrendLabel, direction: salesTrendPositive ? "up" : "down" }
            : undefined
        }
        secondary={[
          {
            key: "bills",
            label: "Bills Processed",
            value: todaySalesCount,
            meta: "Posted today",
          },
          {
            key: "held",
            label: "Held Sales",
            value: holdCount,
            meta: `Value: ${formatMoney(holdValue)}`,
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No counter alerts — all clear" />

      <div className={css.grid3}>
        <DashboardPanel
          title="Shift Performance (Today)"
          className={css.span2}
          compact
          footerMeta={peakHour.value > 0 ? `Peak: ${peakHour.label}` : "No sales hours yet"}
        >
          <SimpleLineChart points={hourlyToday} height={140} formatValue={(n) => formatMoney(n)} />
          <div className={css.inlineStats}>
            <span>
              Today&apos;s sales: <strong>{loading ? "…" : formatMoney(todaySalesTotal)}</strong>
            </span>
            <span>
              Bills: <strong>{loading ? "…" : todaySalesCount}</strong>
            </span>
            <span>
              Opening cash: <strong className={css.placeholderValue}>—</strong>
            </span>
            <span>
              Cash in hand: <strong className={css.placeholderValue}>—</strong>
            </span>
          </div>
          <p className={css.placeholderNote}>
            Hourly chart is live sales. Cash drawer opening / in-hand reconciliation coming soon.
          </p>
        </DashboardPanel>

        <DashboardPanel
          title="Payment Methods Today"
          compact
          badge={paymentMixIsPlaceholder ? <span className={css.placeholderBadge}>Sample</span> : undefined}
        >
          {paymentMixIsPlaceholder ? (
            <>
              <p className={css.emptyState}>No tender data in today&apos;s sales yet.</p>
              <p className={css.placeholderNote}>
                Mix chart stays empty until payment lines are present — not a live sample mix.
              </p>
            </>
          ) : (
            <SimpleDonutChart slices={paymentMix} centerValue={formatMoney(todaySalesTotal)} centerLabel="Total" />
          )}
        </DashboardPanel>
      </div>

      <div className={css.grid3}>
        <DashboardPanel
          title="Recent Transactions"
          className={css.span2}
          compact
          footerHref="/pos"
          footerLabel="Open POS →"
          footerMeta={`${recentSales.length} recent`}
        >
          {recentSales.length === 0 ? (
            <p className={css.emptyState}>No recent transactions yet.</p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Bill No.</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentSales.slice(0, 6).map((sale) => {
                  const method = sale.payments?.[0]?.method;
                  return (
                    <tr key={sale.id}>
                      <td className={css.muted}>{formatRelativeTime(sale.soldAt)}</td>
                      <td>
                        <Link href="/pos" className={css.invoiceLink}>
                          {sale.invoiceNo}
                        </Link>
                      </td>
                      <td>{sale.customer?.fullName ?? "Walk-in"}</td>
                      <td>{formatMoney(sale.grandTotal)}</td>
                      <td className={css.muted}>{paymentLabel(method)}</td>
                      <td>
                        <StatusBadge
                          status={sale.status === "refunded" ? "refunded" : "completed"}
                          label={
                            sale.status === "partially_refunded"
                              ? "Partial return"
                              : sale.status === "refunded"
                                ? "Refunded"
                                : "Completed"
                          }
                          variant={
                            sale.status === "refunded" || sale.status === "partially_refunded"
                              ? "warning"
                              : "success"
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DashboardPanel>

        <DashboardPanel title="Held Bills" compact footerHref="/pos" footerLabel="Recall in POS →" footerMeta={`${holdCount} held`}>
          {holds.length === 0 ? (
            <p className={css.emptyState}>No held sales.</p>
          ) : (
            <ul className={css.pipelineList}>
              {holds.slice(0, 6).map((h) => (
                <li key={h.id}>
                  <div>
                    <strong>{h.holdRef}</strong>
                    <span className={css.muted}>
                      {h.label || h.heldByName} · {formatRelativeTime(h.createdAt)}
                      {h.needsPharmacist ? " · Rx" : ""}
                    </span>
                  </div>
                  <span>{formatMoney(h.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </div>

      <div className={css.grid3}>
        <DashboardPanel title="Fast Moving Counter Items" className={css.span2} compact footerHref="/pos" footerLabel="Open POS →">
          {topProductsToday.length === 0 ? (
            <p className={css.emptyState}>No product velocity yet today.</p>
          ) : (
            <div className={css.productStrip}>
              {topProductsToday.slice(0, 8).map((p) => (
                <div key={p.sku} className={css.productChip}>
                  <span className={css.productAvatar} aria-hidden>
                    {p.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div className={css.productChipBody}>
                    <strong>{p.name}</strong>
                    <span>{p.sku}</span>
                    <em>{p.qty} sold</em>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel title="Customer & Queue" compact headerRight={<span className={css.placeholderBadge}>Sample</span>}>
          <div className={css.queueCard}>
            <p className={css.placeholderNote}>
              Loyalty queue & walk-in CRM not wired — sample layout only. Held bills are in the panel
              above.
            </p>
            <ul className={css.pipelineList}>
              {PLACEHOLDER_CASHIER_QUEUE.map((row) => (
                <li key={row.id}>
                  <div>
                    <strong>{row.name}</strong>
                    <span className={css.muted}>Wait {row.wait}</span>
                  </div>
                  <StatusBadge
                    status="pending"
                    label={row.status}
                    variant={row.status === "Serving" ? "success" : "info"}
                  />
                </li>
              ))}
            </ul>
            <div className={css.metricTiles}>
              <div>
                <span>Loyal today</span>
                <strong className={css.placeholderValue}>—</strong>
              </div>
              <div>
                <span>Points redeemed</span>
                <strong className={css.placeholderValue}>—</strong>
              </div>
            </div>
            <Link href="/pos" className={css.queueSearch}>
              <IconSearch size={14} aria-hidden />
              Search customer in POS…
            </Link>
          </div>
        </DashboardPanel>
      </div>

      <AiInsightsCard insights={CASHIER_AI_INSIGHTS} />

      <QuickActionsBar
        title="Cashier Quick Actions"
        actions={[
          {
            href: "/pos?focus=search",
            label: "Scan / add item",
            icon: <IconBarcodeScan size={18} />,
            roles: POS_ROLES,
            tone: "primary",
          },
          {
            href: "/pos?panel=holds",
            label: "Recall held bill",
            icon: <IconPause size={18} />,
            roles: POS_ROLES,
            tone: "warning",
          },
          {
            href: "/pos?panel=customer",
            label: "Customer lookup",
            icon: <IconUsers size={18} />,
            roles: POS_ROLES,
            tone: "info",
          },
          {
            href: "/pos?mode=returns",
            label: "Process return",
            icon: <IconRotateCcw size={18} />,
            roles: POS_ROLES,
            tone: "danger",
          },
          {
            href: "/returns?status=pending_approval",
            label: "Returns queue",
            icon: <IconReceipt size={18} />,
            roles: RETURNS_ROLES,
            tone: "success",
          },
        ]}
      />
    </>
  );
}
