"use client";

import { useMemo } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconArchive,
  IconBox,
  IconCalendar,
  IconClipboardList,
  IconTruck,
} from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { DashboardFixedGrid } from "../components/dashboard-fixed-grid";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
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
  } = data;

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
      <QuickActionsBar
        title="Owner Quick Actions"
        actions={[
          {
            href: "/purchasing?action=create-po",
            label: "Create PO",
            icon: <IconClipboardList size={17} />,
            roles: PURCHASING_ROLES,
            tone: "primary",
          },
          {
            href: "/purchasing?status=pending_approval",
            label: "Approve POs",
            icon: <IconTruck size={17} />,
            roles: PURCHASING_ROLES,
            tone: "warning",
          },
          {
            href: "/inventory?view=low",
            label: "Low stock queue",
            icon: <IconAlertTriangle size={17} />,
            roles: OPERATIONS_ROLES,
            tone: "warning",
          },
          {
            href: "/inventory/batches?nearExpiryDays=30",
            label: "Near expiry",
            icon: <IconCalendar size={17} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
          {
            href: "/inventory?openAdjustment=1",
            label: "Adjust stock",
            icon: <IconBox size={17} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
          {
            href: "/inventory/movements",
            label: "Stock movements",
            icon: <IconActivity size={17} />,
            roles: OPERATIONS_ROLES,
            tone: "success",
          },
          {
            href: "/transfers?status=requested",
            label: "Transfer approvals",
            icon: <IconTruck size={17} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
          {
            href: "/returns?status=pending_approval",
            label: "Return approvals",
            icon: <IconArchive size={17} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
        ]}
      />

      <HeroBand
        label="Today's Sales"
        value={formatMoney(ownerTodaySalesTotal)}
        scope={`${ownerScopeLabel} · vs yesterday`}
        meta={loading ? undefined : heroMeta}
        loading={loading}
        sparkline={salesTrend7d}
        trend={
          ownerSalesTrendLabel
            ? {
                label: ownerSalesTrendLabel,
                direction: ownerSalesTrendPositive ? "up" : "down",
              }
            : undefined
        }
        secondary={[
          {
            key: "gp",
            label: "Gross Profit · Last 30 Days",
            value: hasMarginData ? formatMoney(ownerGrossProfit30d) : "—",
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
            meta: financial
              ? `${financial.receivablesCustomerCount} customers`
              : undefined,
          },
          {
            key: "payables",
            label: "Outstanding Payables",
            value: financial ? formatMoney(financial.payablesOutstanding) : "—",
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
