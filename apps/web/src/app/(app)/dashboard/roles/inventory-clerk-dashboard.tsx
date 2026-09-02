"use client";

import { useMemo } from "react";
import {
  IconAlertTriangle,
  IconCalendar,
  IconClipboardList,
  IconPackage,
  IconPlus,
  IconRefresh,
  IconTruck,
} from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { INVENTORY_WRITE_ROLES, OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import { useStockValueTrend } from "../hooks/use-stock-value-trend";
import type { WidgetDef } from "../widgets/types";

type Props = { data: DashboardData; catalog: WidgetDef[]; layout: UseDashboardLayoutResult };

export function InventoryClerkDashboard({ data, catalog, layout }: Props) {
  const {
    loading,
    branchId,
    inventory,
    openPos,
    openPoValue,
    overduePos,
    nearExpiryCount,
    openTransfers,
    stocktakesInProgress,
  } = data;

  const { data: valueTrend } = useStockValueTrend(branchId);

  const tickerItems: TickerItem[] = useMemo(() => {
    const items: TickerItem[] = [];
    if (nearExpiryCount > 0) {
      items.push({
        key: "exp",
        count: nearExpiryCount,
        label: "batches expiring ≤30 days",
        tone: "warning",
        href: "/inventory/batches",
      });
    }
    if (openPos > 0) {
      items.push({
        key: "pos",
        count: openPos,
        label: `pending POs · ${formatMoney(openPoValue)}`,
        tone: "info",
        href: "/purchasing",
      });
    }
    if (overduePos > 0) {
      items.push({
        key: "od",
        count: overduePos,
        label: "overdue deliveries",
        tone: "danger",
        href: "/purchasing",
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
  }, [nearExpiryCount, openPos, openPoValue, overduePos, openTransfers, stocktakesInProgress]);

  return (
    <>
      <HeroBand
        label="Stock Value"
        value={inventory ? formatMoney(inventory.stockValue) : "—"}
        scope={inventory ? `${inventory.totalUnits.toLocaleString()} units on hand` : undefined}
        sparkline={valueTrend?.sparkline}
        trend={
          valueTrend
            ? {
                label: `${formatMoney(Math.abs(valueTrend.netValueTotal))} this week`,
                direction: valueTrend.netValueTotal >= 0 ? "up" : "down",
              }
            : undefined
        }
        loading={loading}
        secondary={[
          {
            key: "oos",
            label: "Out of Stock",
            value: inventory?.outOfStock ?? "—",
            meta: "SKUs at zero",
            href: "/inventory?view=out",
            linkLabel: "View items",
          },
          {
            key: "low",
            label: "Low Stock",
            value: inventory?.lowStock ?? "—",
            meta: "At / below reorder",
            href: "/inventory?view=low",
            linkLabel: "View items",
          },
          {
            key: "pos",
            label: "Open POs",
            value: openPos,
            meta: openPos > 0 ? formatMoney(openPoValue) : "None open",
            href: "/purchasing",
            linkLabel: "Open POs",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No stock or delivery alerts — inventory looks healthy" />

      <DashboardCanvas
        catalog={catalog}
        layout={layout.layout}
        data={data}
        isEditing={layout.isEditing}
        loading={layout.loading}
        onLayoutChange={layout.updateLayout}
        onRemoveWidget={layout.removeWidget}
      />

      <QuickActionsBar
        title="Inventory Quick Actions"
        actions={[
          {
            href: "/inventory?openAdjustment=1",
            label: "Adjust stock",
            icon: <IconClipboardList size={18} />,
            roles: INVENTORY_WRITE_ROLES,
            tone: "primary",
          },
          {
            href: "/purchasing?action=create-po",
            label: "Create PO",
            icon: <IconPlus size={18} />,
            roles: PURCHASING_ROLES,
            tone: "success",
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
            href: "/inventory/movements",
            label: "Stock movements",
            icon: <IconPackage size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
          {
            href: "/transfers?action=create",
            label: "Request transfer",
            icon: <IconTruck size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
          {
            href: "/purchasing?status=receivable",
            label: "Receive goods",
            icon: <IconPackage size={18} />,
            roles: PURCHASING_ROLES,
            tone: "success",
          },
          {
            href: "/transfers?status=in_transit",
            label: "Inbound transfers",
            icon: <IconRefresh size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "warning",
          },
        ]}
      />
    </>
  );
}
