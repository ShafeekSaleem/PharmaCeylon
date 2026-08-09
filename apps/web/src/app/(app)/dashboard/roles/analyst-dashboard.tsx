"use client";

import { useMemo } from "react";
import { IconActivity, IconAlertTriangle, IconBarChart, IconPackage } from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { INSIGHTS_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { ProgressBar } from "../components/progress-bar";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleDonutChart, SimpleGroupedBarChart, SimpleLineChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { ANALYST_AI_INSIGHTS } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

type Props = { data: DashboardData };

export function AnalystDashboard({ data }: Props) {
  const {
    loading,
    todaySalesTotal,
    salesTrendLabel,
    salesTrendPositive,
    monthSalesTotal,
    monthSalesCount,
    salesTrend7d,
    revenueVsPurchases,
    paymentMix,
    paymentMixIsPlaceholder,
    inventory,
    reorderCount,
    topReorder,
    marginPct,
    nearExpiryCount,
    canViewPurchasing,
  } = data;

  const lowStockCount = inventory?.lowStock ?? 0;
  const purchSeries = revenueVsPurchases.reduce((s, p) => s + (p.b ?? 0), 0);
  const purchUnavailable = !canViewPurchasing || purchSeries === 0;

  const healthyPct =
    inventory && inventory.skuCount > 0
      ? Math.round((inventory.healthy / inventory.skuCount) * 1000) / 10
      : null;
  const lowPct =
    inventory && inventory.skuCount > 0
      ? Math.round((inventory.lowStock / inventory.skuCount) * 1000) / 10
      : null;
  const oosPct =
    inventory && inventory.skuCount > 0
      ? Math.round((inventory.outOfStock / inventory.skuCount) * 1000) / 10
      : null;

  const tickerItems: TickerItem[] = useMemo(() => {
    const items: TickerItem[] = [];
    if (lowStockCount > 0 || reorderCount > 0) {
      items.push({
        key: "low",
        count: lowStockCount,
        label:
          reorderCount > 0
            ? `SKUs at/below reorder · ${reorderCount} suggestion${reorderCount === 1 ? "" : "s"}`
            : "SKUs at or below reorder level",
        tone: "warning",
        href: "/analytics",
      });
    }
    if (nearExpiryCount > 0) {
      items.push({
        key: "exp",
        count: nearExpiryCount,
        label: "batches expiring ≤30 days",
        tone: "warning",
        href: "/reports?tab=expiry",
      });
    }
    return items;
  }, [lowStockCount, reorderCount, nearExpiryCount]);

  return (
    <>
      <HeroBand
        label="Sales Today"
        value={formatMoney(todaySalesTotal)}
        scope="vs yesterday"
        loading={loading}
        sparkline={salesTrend7d}
        trend={
          salesTrendLabel
            ? { label: salesTrendLabel, direction: salesTrendPositive ? "up" : "down" }
            : undefined
        }
        secondary={[
          {
            key: "month",
            label: "Sales (30 days)",
            value: formatMoney(monthSalesTotal),
            meta: `${monthSalesCount} invoices`,
          },
          {
            key: "margin",
            label: "Gross Margin",
            value: marginPct != null ? `${marginPct.toFixed(1)}%` : "—",
            meta: "30d product margin report",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No stock signals flagged right now" />

      <div className={css.grid3}>
        <DashboardPanel title="Sales Trend (7 days)" className={css.span2}>
          <SimpleLineChart points={salesTrend7d} formatValue={(n) => formatMoney(n)} />
        </DashboardPanel>
        <DashboardPanel
          title="Payment Mix (Today)"
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
            <SimpleDonutChart slices={paymentMix} centerValue={formatMoney(todaySalesTotal)} centerLabel="Today" />
          )}
        </DashboardPanel>
      </div>

      <div className={css.grid3}>
        <DashboardPanel title="Revenue vs Purchases" footerHref="/reports" footerLabel="Open reports →">
          {purchUnavailable ? (
            <p className={css.placeholderNote}>
              Revenue is from sales. Purchase bars need PO access — empty for Analyst.
            </p>
          ) : (
            <p className={css.placeholderNote}>
              Purchases approximated from PO created dates (not received GRNs).
            </p>
          )}
          <SimpleGroupedBarChart points={revenueVsPurchases} aLabel="Revenue" bLabel="Purchases" />
        </DashboardPanel>

        <DashboardPanel title="Inventory Health" footerHref="/analytics" footerLabel="Open analytics →">
          <div className={css.healthPills}>
            <span className={`${css.healthPill} ${css.healthPill_neutral}`}>
              SKUs
              <strong>{inventory?.skuCount ?? "—"}</strong>
            </span>
            <span className={`${css.healthPill} ${css.healthPill_success}`}>
              Healthy{healthyPct != null ? ` ${healthyPct}%` : ""}
              <strong>{inventory?.healthy ?? "—"}</strong>
            </span>
            <span className={`${css.healthPill} ${css.healthPill_warning}`}>
              Low{lowPct != null ? ` ${lowPct}%` : ""}
              <strong>{inventory?.lowStock ?? "—"}</strong>
            </span>
            <span className={`${css.healthPill} ${css.healthPill_danger}`}>
              Out{oosPct != null ? ` ${oosPct}%` : ""}
              <strong>{inventory?.outOfStock ?? "—"}</strong>
            </span>
          </div>
          <div className={css.metricTiles}>
            <div>
              <span>Near expiry</span>
              <strong>{nearExpiryCount}</strong>
            </div>
            <div>
              <span>Stock value</span>
              <strong>{inventory ? formatMoney(inventory.stockValue) : "—"}</strong>
            </div>
          </div>
          {healthyPct != null ? (
            <div className={css.stackMtSm}>
              <ProgressBar value={healthyPct} label={`${healthyPct}% healthy`} tone="success" />
            </div>
          ) : null}
        </DashboardPanel>

        <DashboardPanel title="Top Reorder" footerHref="/analytics" footerLabel="Open analytics →">
          {topReorder.length === 0 ? (
            <p className={css.emptyState}>No reorder suggestions right now.</p>
          ) : (
            <ul className={css.reorderList}>
              {topReorder.map((item) => (
                <li key={item.sku} className={css.reorderItem}>
                  <span className={css.reorderSku}>{item.sku}</span>
                  <span className={css.muted}>
                    {item.name} · {item.onHand} on hand → order {item.suggestedQty}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </div>

      <AiInsightsCard insights={ANALYST_AI_INSIGHTS} footerHref="/analytics" footerLabel="Open analytics →" />

      <QuickActionsBar
        title="Analyst Quick Actions"
        actions={[
          {
            href: "/reports?tab=sales",
            label: "Sales summary",
            icon: <IconBarChart size={18} />,
            roles: INSIGHTS_ROLES,
            tone: "primary",
          },
          {
            href: "/reports?tab=margin",
            label: "Margin report",
            icon: <IconActivity size={18} />,
            roles: INSIGHTS_ROLES,
            tone: "success",
          },
          {
            href: "/reports?tab=expiry",
            label: "Near expiry report",
            icon: <IconAlertTriangle size={18} />,
            roles: INSIGHTS_ROLES,
            tone: "warning",
          },
          {
            href: "/reports?tab=dead",
            label: "Dead stock report",
            icon: <IconPackage size={18} />,
            roles: INSIGHTS_ROLES,
            tone: "danger",
          },
        ]}
      />
    </>
  );
}
