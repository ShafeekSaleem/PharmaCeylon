"use client";

import { useMemo } from "react";
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
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import type { WidgetDef } from "../widgets/types";

type Props = { data: DashboardData; catalog: WidgetDef[]; layout: UseDashboardLayoutResult };

export function ManagerDashboard({ data, catalog, layout }: Props) {
  const {
    loading,
    inventory,
    todaySalesTotal,
    salesTrendLabel,
    salesTrendPositive,
    todaySalesCount,
    salesTrend7d,
    pendingApprovalsTotal,
    currentBranchPerf,
    nearExpiryCount,
    overduePos,
    openTransfers,
    stocktakesInProgress,
    controlledAttentionCount,
    dispensedToday,
    dispensedTrendLabel,
    dispensedTrendPositive,
  } = data;

  const tickerItems: TickerItem[] = useMemo(() => {
    const items: TickerItem[] = [];
    if (controlledAttentionCount > 0) {
      items.push({
        key: "ctrl",
        count: controlledAttentionCount,
        label: "controlled-drug alerts",
        tone: "danger",
        href: "/inventory?controlled=controlled",
      });
    }
    if ((inventory?.outOfStock ?? 0) > 0) {
      items.push({
        key: "oos",
        count: inventory!.outOfStock,
        label: "items out of stock",
        tone: "danger",
        href: "/inventory?view=out",
      });
    }
    if ((inventory?.lowStock ?? 0) > 0) {
      items.push({
        key: "low",
        count: inventory!.lowStock,
        label: "low stock items",
        tone: "warning",
        href: "/inventory?view=low",
      });
    }
    if (nearExpiryCount > 0) {
      items.push({
        key: "exp",
        count: nearExpiryCount,
        label: "near-expiry batches",
        tone: "warning",
        href: "/inventory/batches",
      });
    }
    if (overduePos > 0) {
      items.push({
        key: "od",
        count: overduePos,
        label: "overdue purchase orders",
        tone: "warning",
        href: "/purchasing?status=overdue",
      });
    }
    if (openTransfers > 0) {
      items.push({
        key: "xfer",
        count: openTransfers,
        label: "open transfers",
        tone: "info",
        href: "/transfers",
      });
    }
    if (stocktakesInProgress > 0) {
      items.push({
        key: "st",
        count: stocktakesInProgress,
        label: "stocktakes in progress",
        tone: "info",
        href: "/stocktakes",
      });
    }
    return items;
  }, [
    controlledAttentionCount,
    inventory,
    nearExpiryCount,
    overduePos,
    openTransfers,
    stocktakesInProgress,
  ]);

  return (
    <>
      <HeroBand
        label="Today's Sales"
        value={formatMoney(todaySalesTotal)}
        scope="This branch · vs yesterday"
        meta={loading ? undefined : `${todaySalesCount} transaction${todaySalesCount === 1 ? "" : "s"} today`}
        loading={loading}
        sparkline={salesTrend7d}
        trend={
          salesTrendLabel
            ? { label: salesTrendLabel, direction: salesTrendPositive ? "up" : "down" }
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
            label: "Pending Approvals",
            value: pendingApprovalsTotal,
            meta: "POs, transfers & returns — see below",
          },
          {
            key: "units",
            label: "Units Sold Today",
            value: dispensedToday,
            meta: "This branch",
            trend: dispensedTrendLabel
              ? { label: dispensedTrendLabel, direction: dispensedTrendPositive ? "up" : "down" }
              : undefined,
            href: "/reports?category=sales&report=sales-summary",
            linkLabel: "View reports",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No operational alerts — branch looks healthy" />

      <DashboardCanvas
        catalog={catalog}
        layout={layout.layout}
        data={data}
        isEditing={layout.isEditing}
        onLayoutChange={layout.updateLayout}
        onRemoveWidget={layout.removeWidget}
      />

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
    </>
  );
}
