"use client";

import {
  IconAlertTriangle,
  IconBox,
  IconCalendar,
  IconClipboardList,
  IconPackage,
  IconRefresh,
  IconShoppingCart,
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
  } = data;

  return (
    <>
      <QuickActionsBar
        title="Manager Quick Actions"
        actions={[
          {
            href: "/purchasing?status=pending_approval",
            label: "Approve POs",
            icon: <IconClipboardList size={18} />,
            roles: PURCHASING_ROLES,
            tone: "warning",
          },
          {
            href: "/transfers?status=requested",
            label: "Transfer approvals",
            icon: <IconTruck size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
          {
            href: "/returns?status=pending_approval",
            label: "Return approvals",
            icon: <IconRefresh size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
          {
            href: "/purchasing?action=create-po",
            label: "Create PO",
            icon: <IconShoppingCart size={18} />,
            roles: PURCHASING_ROLES,
            tone: "primary",
          },
          {
            href: "/inventory?view=low",
            label: "Low stock queue",
            icon: <IconAlertTriangle size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "warning",
          },
          {
            href: "/inventory/batches?nearExpiryDays=30",
            label: "Near expiry",
            icon: <IconCalendar size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
          {
            href: "/inventory?openAdjustment=1",
            label: "Adjust stock",
            icon: <IconPackage size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "success",
          },
          {
            href: "/transfers?action=create",
            label: "Request transfer",
            icon: <IconBox size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
        ]}
      />

      <HeroBand
        label="Today's Sales"
        value={data.salesMetrics ? formatMoney(todaySalesTotal) : "—"}
        scope="This branch · vs yesterday"
        meta={
          loading
            ? undefined
            : `${todaySalesCount} transaction${todaySalesCount === 1 ? "" : "s"} today`
        }
        loading={loading}
        sparkline={salesTrend7d}
        trend={
          salesTrendLabel
            ? {
                label: salesTrendLabel,
                direction: salesTrendPositive ? "up" : "down",
              }
            : undefined
        }
        secondary={[
          {
            key: "target",
            label: "Target Achievement",
            value:
              currentBranchPerf?.achievementPct != null
                ? `${currentBranchPerf.achievementPct.toFixed(0)}%`
                : "—",
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
            value: data.salesMetrics ? todaySalesCount : "—",
            meta: "All operators · this branch",
          },
          {
            key: "units",
            label: "Units Sold Today",
            value: dispensedToday,
            meta: "This branch",
            trend: dispensedTrendLabel
              ? {
                  label: dispensedTrendLabel,
                  direction: dispensedTrendPositive ? "up" : "down",
                }
              : undefined,
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
