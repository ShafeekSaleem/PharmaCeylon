"use client";

import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { DashboardFixedGrid } from "../components/dashboard-fixed-grid";
import { HeroBand } from "../components/hero-band";
import {
  isDashboardServerUnreachable,
  isMetricUnavailable,
} from "../lib/dashboard-connectivity";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import type { WidgetDef } from "../widgets/types";
import css from "../dashboard.module.css";

type Props = {
  data: DashboardData;
  catalog: WidgetDef[];
  layout: UseDashboardLayoutResult;
  refreshKey: string | null;
  counterLive: boolean;
};

export function ManagerDashboard({
  data,
  catalog,
  layout,
  refreshKey,
  counterLive,
}: Props) {
  const {
    loading,
    todaySalesTotal,
    salesTrendLabel,
    salesTrendPositive,
    todaySalesCount,
    salesTrend7d,
    currentBranchPerf,
    dispensedToday,
    dispensedTrendLabel,
    dispensedTrendPositive,
    failedSections,
  } = data;

  const serverUnreachable = isDashboardServerUnreachable(data);
  const salesUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Sales metrics"],
  );
  const branchPerfUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Branch Performance", "Sales overview"],
  );

  return (
    <>
      <HeroBand
        label="Today's Sales"
        value={formatMoney(todaySalesTotal)}
        scope="This branch · vs yesterday"
        meta={`${todaySalesCount} transaction${todaySalesCount === 1 ? "" : "s"} today`}
        loading={loading}
        unavailable={salesUnavailable}
        sparkline={salesUnavailable ? undefined : salesTrend7d}
        trend={
          salesUnavailable || !salesTrendLabel
            ? undefined
            : {
                label: salesTrendLabel,
                direction: salesTrendPositive ? "up" : "down",
              }
        }
        secondary={[
          {
            key: "target",
            label: "Target Achievement",
            value:
              currentBranchPerf?.achievementPct != null
                ? `${currentBranchPerf.achievementPct.toFixed(0)}%`
                : "—",
            unavailable: branchPerfUnavailable,
            meta:
              currentBranchPerf?.targetAmount != null
                ? `MTD ${formatMoney(currentBranchPerf.monthSales)} / ${formatMoney(currentBranchPerf.targetAmount)}`
                : "Assigned by owner",
            href: "/reports?category=sales&report=branch-sales",
            linkLabel: "View reports",
          },
          {
            key: "approvals",
            label: "Transactions Today",
            value: todaySalesCount,
            unavailable: salesUnavailable,
            meta: "All operators · this branch",
          },
          {
            key: "units",
            label: "Units Sold Today",
            value: dispensedToday,
            unavailable: salesUnavailable,
            meta: "This branch",
            trend:
              salesUnavailable || !dispensedTrendLabel
                ? undefined
                : {
                    label: dispensedTrendLabel,
                    direction: dispensedTrendPositive ? "up" : "down",
                  },
            href: "/reports?category=sales&report=sales-summary",
            linkLabel: "View reports",
          },
        ]}
      />

      <DashboardFixedGrid
        role="manager"
        data={data}
        refreshKey={refreshKey}
        counterLive={counterLive}
      />

      <div className={css.optionalWidgets}>
        <DashboardCanvas
          catalog={catalog}
          layout={layout.layout}
          data={data}
          isEditing={layout.isEditing}
          loading={layout.loading}
          onLayoutChange={layout.updateLayout}
          onRemoveWidget={layout.removeWidget}
        />
      </div>
    </>
  );
}