"use client";

import { useMemo } from "react";
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

export function OwnerDashboard({
  data,
  catalog,
  layout,
  refreshKey,
  counterLive,
}: Props) {
  const {
    loading,
    salesTrend7d,
    ownerScopeLabel,
    ownerTodaySalesTotal,
    ownerTodayTxnCount,
    ownerSalesTrendLabel,
    ownerSalesTrendPositive,
    ownerGrossProfit30d,
    branchesReportingToday,
    branchesReportingTotal,
    ownerScope,
    hasMarginData,
    marginPct,
    financial,
    failedSections,
  } = data;

  const serverUnreachable = isDashboardServerUnreachable(data);
  const salesUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Sales metrics"],
  );
  const marginUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Product margins"],
  );
  const financialUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Financial Snapshot"],
  );

  const heroMeta = useMemo(() => {
    const txnLabel = `${ownerTodayTxnCount} transaction${ownerTodayTxnCount === 1 ? "" : "s"}`;
    if (ownerScope === "this_branch") return `${txnLabel} today`;
    return `${txnLabel} · ${branchesReportingToday} of ${branchesReportingTotal} branches reporting`;
  }, [
    ownerTodayTxnCount,
    ownerScope,
    branchesReportingToday,
    branchesReportingTotal,
  ]);

  return (
    <>
      <HeroBand
        label="Today's Sales"
        value={formatMoney(ownerTodaySalesTotal)}
        scope={`${ownerScopeLabel} · vs yesterday`}
        meta={heroMeta}
        loading={loading}
        unavailable={salesUnavailable}
        sparkline={salesUnavailable ? undefined : salesTrend7d}
        trend={
          salesUnavailable || !ownerSalesTrendLabel
            ? undefined
            : {
                label: ownerSalesTrendLabel,
                direction: ownerSalesTrendPositive ? "up" : "down",
              }
        }
        secondary={[
          {
            key: "gp",
            label: "Gross Profit · Last 30 Days",
            value: hasMarginData ? formatMoney(ownerGrossProfit30d) : "—",
            unavailable: marginUnavailable,
            meta:
              hasMarginData && marginPct != null
                ? `30-day margin ${marginPct.toFixed(1)}%`
                : "From margin report",
            href: "/reports?category=profitability&report=gross-profit",
            linkLabel: "View margin",
          },
          {
            key: "recv",
            label: "Recorded Credit Sales",
            value: financial
              ? formatMoney(financial.receivablesOutstanding)
              : "—",
            unavailable: financialUnavailable,
            meta: financial
              ? `${financial.receivablesCustomerCount} customers`
              : undefined,
          },
          {
            key: "payables",
            label: "Outstanding Payables",
            value: financial ? formatMoney(financial.payablesOutstanding) : "—",
            unavailable: financialUnavailable,
            meta: financial
              ? `${financial.payablesSupplierCount} suppliers`
              : undefined,
            href: "/suppliers",
            linkLabel: "Open suppliers",
          },
        ]}
      />

      <DashboardFixedGrid
        role="owner"
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