"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconActivity,
  IconBarcodeScan,
  IconCreditCard,
  IconPause,
  IconReceipt,
  IconRotateCcw,
  IconSearch,
  IconShoppingCart,
  IconUsers,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { CATALOG_ROLES, POS_ROLES, RETURNS_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { CustomerBreakdownPanel } from "../components/customer-breakdown-panel";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { MasonryGrid, MasonryItem } from "../components/masonry-grid";
import { MetricCell, pctChange } from "../components/metric-cell";
import { PaginationControls } from "../components/pagination-controls";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleDonutChart, SimpleLineChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { useCustomerBreakdown } from "../hooks/use-customer-breakdown";
import { rowLinkProps } from "../lib/row-link";
import { CASHIER_AI_INSIGHTS, type AiInsight } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

type Props = { data: DashboardData };

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return items.slice(safePage * pageSize, safePage * pageSize + pageSize);
}

function paymentLabel(method: string | undefined): string {
  if (!method) return "—";
  return method.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function CashierDashboard({ data }: Props) {
  const router = useRouter();
  const {
    loading,
    todaySalesTotal,
    todaySalesCount,
    yesterdaySalesTotal,
    yesterdaySalesCount,
    salesTrendLabel,
    salesTrendPositive,
    billsTrendLabel,
    billsTrendPositive,
    holdCount,
    holdValue,
    holds,
    pharmacistHolds,
    returnsTodayCount,
    returnsTodayTotal,
    hourlyToday,
    paymentMix,
    paymentMixIsPlaceholder,
    todaySales,
    topProductsToday,
    lowStockRows,
    branchId,
  } = data;

  const rxWaiting = pharmacistHolds.length;
  const peakHour = hourlyToday.reduce(
    (best, p) => (p.value > best.value ? p : best),
    hourlyToday[0] ?? { label: "—", value: 0 },
  );
  const avgBillValue = todaySalesCount > 0 ? todaySalesTotal / todaySalesCount : 0;
  const avgBillValueYesterday = yesterdaySalesCount > 0 ? yesterdaySalesTotal / yesterdaySalesCount : 0;
  const avgBillTrendPct =
    yesterdaySalesCount > 0 ? pctChange(avgBillValue, avgBillValueYesterday) : null;
  const billsTrendPct = yesterdaySalesCount > 0 ? pctChange(todaySalesCount, yesterdaySalesCount) : null;

  const topPaymentMethod = useMemo(() => {
    if (paymentMixIsPlaceholder || paymentMix.length === 0) return null;
    const total = paymentMix.reduce((s, p) => s + p.value, 0);
    const top = paymentMix.reduce((a, b) => (b.value > a.value ? b : a));
    return { label: top.label, pct: total > 0 ? (top.value / total) * 100 : 0 };
  }, [paymentMix, paymentMixIsPlaceholder]);

  const oldestHoldWait = useMemo(() => {
    if (holds.length === 0) return null;
    const oldest = holds.reduce((a, b) => (new Date(a.createdAt) < new Date(b.createdAt) ? a : b));
    return formatRelativeTime(oldest.createdAt);
  }, [holds]);

  const [fastItemsPage, setFastItemsPage] = useState(0);
  const FAST_ITEMS_PAGE_SIZE = 6;
  const fastItemsPageCount = Math.max(1, Math.ceil(topProductsToday.length / FAST_ITEMS_PAGE_SIZE));

  const [recentSalesPage, setRecentSalesPage] = useState(0);
  const RECENT_SALES_PAGE_SIZE = 6;
  const recentSalesPageCount = Math.max(1, Math.ceil(todaySales.length / RECENT_SALES_PAGE_SIZE));

  const { data: breakdown } = useCustomerBreakdown(branchId);

  const tickerItems: TickerItem[] = useMemo(() => {
    const items: TickerItem[] = [];
    if (rxWaiting > 0) {
      items.push({
        key: "rx",
        count: rxWaiting,
        label: "prescription items waiting verification",
        tone: "danger",
        href: "/pos?panel=holds",
      });
    }
    if (holdCount > 5) {
      items.push({
        key: "holds",
        count: holdCount,
        label: "held sales backlog at counter",
        tone: "warning",
        href: "/pos?panel=holds",
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

  const liveInsights = useMemo(() => {
    const live: AiInsight[] = [];
    if (lowStockRows.length > 0) {
      live.push({
        id: "live-lowstock",
        title: "Stock up fast mover",
        detail: `${lowStockRows.length} counter SKU${lowStockRows.length === 1 ? "" : "s"} running low — check before your next restock round.`,
        tone: "warning",
        href: "/inventory?view=low",
        actionLabel: "View low stock",
      });
    }
    if (rxWaiting > 0) {
      live.push({
        id: "live-rx",
        title: "Verify prescription-required items",
        detail: `${rxWaiting} held cart${rxWaiting === 1 ? "" : "s"} waiting on pharmacist verification before checkout.`,
        tone: "danger",
        href: "/pos?panel=holds",
        actionLabel: "Open POS",
      });
    }
    return live;
  }, [lowStockRows.length, rxWaiting]);

  const allInsights = useMemo(() => {
    const filler = CASHIER_AI_INSIGHTS.filter((s) => !liveInsights.some((l) => l.title === s.title));
    return [...liveInsights, ...filler].slice(0, 4);
  }, [liveInsights]);

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
            trend: billsTrendLabel
              ? { label: billsTrendLabel, direction: billsTrendPositive ? "up" : "down" }
              : undefined,
            href: "/pos",
            linkLabel: "Open POS",
          },
          {
            key: "held",
            label: "Held Sales",
            value: holdCount,
            meta: `Value: ${formatMoney(holdValue)}`,
            href: "/pos?panel=holds",
            linkLabel: "View holds",
          },
          {
            key: "customers",
            label: "Customers Today",
            value: breakdown?.total ?? 0,
            meta: breakdown ? (
              <span className={css.heroBreakdownRow}>
                <span className={css.heroBreakdownItem}>
                  <i className={css.heroBreakdownDot} style={{ background: "var(--pc-muted-fg)" }} />
                  {breakdown.walkIn} walk-in
                </span>
                <span className={css.heroBreakdownItem}>
                  <i className={css.heroBreakdownDot} style={{ background: "var(--pc-primary)" }} />
                  {breakdown.registered} registered
                </span>
              </span>
            ) : undefined,
            href: "/pos?panel=customer",
            linkLabel: "Find customer",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No counter alerts — all clear" />

      <MasonryGrid>
        <MasonryItem span={2}>
        <DashboardPanel
          title="Shift Performance (Today)"
          compact
          footerMeta={peakHour.value > 0 ? `Peak: ${peakHour.label}` : "No sales hours yet"}
        >
          <SimpleLineChart
            points={hourlyToday}
            height={140}
            formatValue={(n) => formatMoney(n)}
            aLabel="Sales (LKR)"
            showYAxis
            dense
          />
          <div className={css.overviewChartsSummary} style={{ marginTop: "0.5rem" }}>
            <MetricCell
              label="Bills"
              value={loading ? "…" : String(todaySalesCount)}
              icon={<IconShoppingCart size={16} strokeWidth={1.75} />}
              iconTone="bills"
              trend={billsTrendPct != null ? { pct: billsTrendPct, compareLabel: "vs Yesterday" } : undefined}
            />
            <MetricCell
              label="Avg bill value"
              value={loading ? "…" : formatMoney(avgBillValue)}
              icon={<IconReceipt size={16} strokeWidth={1.75} />}
              iconTone="avg"
              trend={avgBillTrendPct != null ? { pct: avgBillTrendPct, compareLabel: "vs Yesterday" } : undefined}
            />
            <MetricCell
              label="Peak hour sales"
              value={loading ? "…" : peakHour.value > 0 ? formatMoney(peakHour.value) : "—"}
              icon={<IconActivity size={16} strokeWidth={1.75} />}
              iconTone="peak"
            />
          </div>
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
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
            <>
              <SimpleDonutChart
                slices={paymentMix}
                centerValue={formatMoney(todaySalesTotal)}
                centerLabel="Total"
                formatValue={(n) => formatMoney(n)}
              />
              {topPaymentMethod ? (
                <p className={css.footfallFooterMeta} style={{ marginTop: "0.6rem" }}>
                  <span className={css.footfallPeakPill}>
                    <IconCreditCard size={11} strokeWidth={2.5} aria-hidden />
                    {topPaymentMethod.label} leads
                  </span>
                  <span className={css.muted}>{topPaymentMethod.pct.toFixed(0)}% of today&apos;s tenders</span>
                </p>
              ) : null}
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
          <CustomerBreakdownPanel branchId={branchId} />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Held Bills"
          compact
          footerHref="/pos"
          footerLabel="Recall in POS →"
          footerMeta={oldestHoldWait ? `Oldest ${oldestHoldWait}` : `${holdCount} held`}
        >
          {holds.length === 0 ? (
            <p className={css.emptyState}>No held sales.</p>
          ) : (
            <>
              <div className={css.teamStatStrip} style={{ marginBottom: "0.65rem" }}>
                <div className={css.teamStatCell}>
                  <div className={css.teamStatCopy}>
                    <strong className={css.teamStatValue}>{holdCount}</strong>
                    <span className={css.teamStatLabel}>Held</span>
                  </div>
                </div>
                <div className={css.teamStatCell}>
                  <div className={css.teamStatCopy}>
                    <strong className={`${css.teamStatValue} ${css.teamStatValue_success}`}>
                      {holdCount - rxWaiting}
                    </strong>
                    <span className={css.teamStatLabel}>Ready</span>
                  </div>
                </div>
                <div className={css.teamStatCell}>
                  <div className={css.teamStatCopy}>
                    <strong className={`${css.teamStatValue} ${css.teamStatValue_danger}`}>
                      {rxWaiting}
                    </strong>
                    <span className={css.teamStatLabel}>Awaiting Rx</span>
                  </div>
                </div>
              </div>
              <ul className={css.pipelineList}>
                {holds.slice(0, 5).map((h) => (
                  <li key={h.id}>
                    <Link href={`/pos?panel=holds&holdId=${h.id}`}>
                      <span
                        className={css.pipelineIcon}
                        aria-hidden
                        style={{
                          color: h.needsPharmacist
                            ? "var(--pc-alert-error-icon)"
                            : "var(--pc-alert-success-icon)",
                          background: h.needsPharmacist
                            ? "color-mix(in srgb, var(--pc-alert-error-icon) 14%, var(--pc-card-bg))"
                            : "color-mix(in srgb, var(--pc-alert-success-icon) 14%, var(--pc-card-bg))",
                        }}
                      >
                        <IconPause size={14} strokeWidth={1.75} />
                      </span>
                      <span className={css.pipelineRowBody}>
                        <strong>{h.holdRef}</strong>
                        <span className={css.muted}>
                          {h.label || h.heldByName} · {formatRelativeTime(h.createdAt)}
                        </span>
                      </span>
                      {h.needsPharmacist ? (
                        <StatusBadge status="pending" label="Rx" variant="danger" />
                      ) : null}
                      <span>{formatMoney(h.total)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Fast Moving Counter Items" compact footerHref="/pos" footerLabel="Open POS →">
          {topProductsToday.length === 0 ? (
            <p className={css.emptyState}>No product velocity yet today.</p>
          ) : (
            <>
              <div className={`${css.productStrip} ${css.productStripWrap}`}>
                {paginate(topProductsToday, fastItemsPage, FAST_ITEMS_PAGE_SIZE).map((p) => (
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
                page={fastItemsPage}
                pageCount={fastItemsPageCount}
                onPrev={() => setFastItemsPage((p) => Math.max(0, p - 1))}
                onNext={() => setFastItemsPage((p) => Math.min(fastItemsPageCount - 1, p + 1))}
                rangeLabel={`${fastItemsPage * FAST_ITEMS_PAGE_SIZE + 1}–${Math.min(topProductsToday.length, (fastItemsPage + 1) * FAST_ITEMS_PAGE_SIZE)} of ${topProductsToday.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
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
                {todaySales.length > 0 ? (
                  <span className={css.monthPill}>Avg {formatMoney(avgBillValue)}</span>
                ) : null}
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
                  {paginate(todaySales, recentSalesPage, RECENT_SALES_PAGE_SIZE).map((sale) => (
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
                            sale.status === "refunded" || sale.status === "partially_refunded"
                              ? "warning"
                              : "success"
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <PaginationControls
                page={recentSalesPage}
                pageCount={recentSalesPageCount}
                onPrev={() => setRecentSalesPage((p) => Math.max(0, p - 1))}
                onNext={() => setRecentSalesPage((p) => Math.min(recentSalesPageCount - 1, p + 1))}
                rangeLabel={`${recentSalesPage * RECENT_SALES_PAGE_SIZE + 1}–${Math.min(todaySales.length, (recentSalesPage + 1) * RECENT_SALES_PAGE_SIZE)} of ${todaySales.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
          <AiInsightsCard insights={allInsights} footerHref="/pos" />
        </MasonryItem>
      </MasonryGrid>

      <QuickActionsBar
        title="Cashier Quick Actions"
        actions={[
          {
            href: "/pos",
            label: "New Sale",
            icon: <IconShoppingCart size={18} />,
            roles: POS_ROLES,
            tone: "primary",
          },
          {
            href: "/pos?panel=holds",
            label: "Recall Bill",
            icon: <IconPause size={18} />,
            roles: POS_ROLES,
            tone: "warning",
          },
          {
            href: "/pos?panel=customer",
            label: "Customer Lookup",
            icon: <IconUsers size={18} />,
            roles: POS_ROLES,
            tone: "info",
          },
          {
            href: "/pos?panel=receipt",
            label: "Last Receipt",
            icon: <IconReceipt size={18} />,
            roles: POS_ROLES,
            tone: "success",
          },
          {
            href: "/pos?focus=search",
            label: "Scan Barcode",
            icon: <IconBarcodeScan size={18} />,
            roles: POS_ROLES,
            tone: "primary",
          },
          {
            href: "/catalog",
            label: "Price Check",
            icon: <IconSearch size={18} />,
            roles: CATALOG_ROLES,
            tone: "info",
          },
          {
            href: "/pos?mode=returns",
            label: "Process Return",
            icon: <IconRotateCcw size={18} />,
            roles: POS_ROLES,
            tone: "danger",
          },
          {
            href: "/returns?status=pending_approval",
            label: "Returns Queue",
            icon: <IconReceipt size={18} />,
            roles: RETURNS_ROLES,
            tone: "success",
          },
        ]}
      />
    </>
  );
}
