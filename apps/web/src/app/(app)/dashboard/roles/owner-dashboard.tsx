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
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import type { WidgetDef } from "../widgets/types";

type Props = { data: DashboardData; catalog: WidgetDef[]; layout: UseDashboardLayoutResult };

export function OwnerDashboard({ data, catalog, layout }: Props) {
  const {
    loading,
    ownerLowStock,
    nearExpiryCount,
    salesTrend7d,
    overduePos,
    pendingApproval,
    financial,
    openTransfers,
    controlledAttentionCount,
    ownerScopeLabel,
    ownerTodaySalesTotal,
    ownerTodayTxnCount,
    ownerSalesTrendLabel,
    ownerSalesTrendPositive,
    ownerTodayGrossProfit,
    ownerGrossProfitTrendLabel,
    ownerGrossProfitTrendPositive,
    branchesReportingToday,
    branchesReportingTotal,
    ownerScope,
    hasMarginData,
    marginPct,
    pendingApprovalListFull,
  } = data;

  const pendingApprovalValue = useMemo(
    () =>
      pendingApprovalListFull.reduce(
        (sum, po) =>
          sum + po.items.reduce((lineSum, item) => lineSum + Number(item.unitCost) * item.orderedQty, 0),
        0,
      ),
    [pendingApprovalListFull],
  );

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
    if ((ownerLowStock ?? 0) > 0) {
      items.push({
        key: "low",
        count: ownerLowStock!,
        label: "low stock items",
        tone: "warning",
        href: "/inventory?view=low",
      });
    }
    if (nearExpiryCount > 0) {
      items.push({
        key: "expiry",
        count: nearExpiryCount,
        label: "expiring ≤30 days",
        tone: "warning",
        href: "/inventory/batches?nearExpiryDays=30",
      });
    }
    if (overduePos > 0) {
      items.push({
        key: "overdue",
        count: overduePos,
        label: "overdue deliveries",
        tone: "danger",
        href: "/purchasing?status=overdue",
      });
    }
    if (pendingApproval > 0) {
      items.push({
        key: "po",
        count: pendingApproval,
        label: `POs pending approval · ${formatMoney(pendingApprovalValue)}`,
        tone: "info",
        href: "/purchasing?status=pending_approval",
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
    return items;
  }, [
    controlledAttentionCount,
    ownerLowStock,
    nearExpiryCount,
    overduePos,
    pendingApproval,
    pendingApprovalValue,
    openTransfers,
  ]);

  const scopePhrase = ownerScopeLabel.toLowerCase();
  const kpisLoading = loading || data.ownerKpisPending;

  const heroMeta = useMemo(() => {
    const txnLabel = `${ownerTodayTxnCount} transaction${ownerTodayTxnCount === 1 ? "" : "s"}`;
    if (ownerScope === "this_branch") return `${txnLabel} today`;
    return `${txnLabel} · ${branchesReportingToday} of ${branchesReportingTotal} branches reporting`;
  }, [ownerTodayTxnCount, ownerScope, branchesReportingToday, branchesReportingTotal]);

  return (
    <>
      <HeroBand
        label="Today's Sales"
        value={formatMoney(ownerTodaySalesTotal)}
        scope={`${ownerScopeLabel} · vs yesterday`}
        meta={loading ? undefined : heroMeta}
        loading={loading}
        sparkline={salesTrend7d}
        trend={
          ownerSalesTrendLabel
            ? { label: ownerSalesTrendLabel, direction: ownerSalesTrendPositive ? "up" : "down" }
            : undefined
        }
        secondary={[
          {
            key: "gp",
            label: "Gross Profit (Today)",
            value: hasMarginData ? formatMoney(ownerTodayGrossProfit) : "—",
            meta:
              hasMarginData && marginPct != null
                ? `Margin ${marginPct.toFixed(1)}%`
                : "From margin report",
            trend:
              hasMarginData && ownerGrossProfitTrendLabel
                ? {
                    label: ownerGrossProfitTrendLabel,
                    direction: ownerGrossProfitTrendPositive ? "up" : "down",
                  }
                : undefined,
            href: "/reports?tab=margin",
            linkLabel: "View margin",
          },
          {
            key: "recv",
            label: "Outstanding Receivables",
            value: financial ? formatMoney(financial.receivablesOutstanding) : "—",
            meta: financial ? `${financial.receivablesCustomerCount} customers` : undefined,
          },
          {
            key: "payables",
            label: "Outstanding Payables",
            value: financial ? formatMoney(financial.payablesOutstanding) : "—",
            meta: financial ? `${financial.payablesSupplierCount} suppliers` : undefined,
            href: "/suppliers",
            linkLabel: "Open suppliers",
          },
        ]}
      />

      <AttentionTicker
        items={tickerItems}
        loading={kpisLoading}
        allClearText={`No alerts — ${scopePhrase} looks healthy`}
      />

      <DashboardCanvas
        catalog={catalog}
        layout={layout.layout}
        data={data}
        isEditing={layout.isEditing}
        onLayoutChange={layout.updateLayout}
        onRemoveWidget={layout.removeWidget}
      />

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
    </>
  );
}
