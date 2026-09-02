"use client";

import { useMemo } from "react";
import {
  IconAlertTriangle,
  IconCalendar,
  IconPackage,
  IconPill,
  IconRotateCcw,
  IconSearch,
  IconStethoscope,
} from "@/components/icons";
import { formatRelativeTime } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, POS_ROLES } from "@/lib/role-access";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import type { WidgetDef } from "../widgets/types";

type Props = { data: DashboardData; catalog: WidgetDef[]; layout: UseDashboardLayoutResult };

export function PharmacistDashboard({ data, catalog, layout }: Props) {
  const {
    loading,
    pharmacistHolds,
    nearExpiryCount,
    nearExpiryItems,
    dispensedToday,
    dispensedTrendLabel,
    dispensedTrendPositive,
    hourlyUnitsToday,
    lowStockRows,
    controlledAttentionCount,
    controlledLowStockCount,
    controlledNearExpiryCount,
    returnsTodayCount,
  } = data;

  const oldestHoldWait = useMemo(() => {
    if (pharmacistHolds.length === 0) return null;
    const oldest = pharmacistHolds.reduce((a, b) =>
      new Date(a.createdAt) < new Date(b.createdAt) ? a : b,
    );
    return formatRelativeTime(oldest.createdAt);
  }, [pharmacistHolds]);

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
    if (lowStockRows.length > 0) {
      items.push({
        key: "low",
        count: lowStockRows.length,
        label: "low stock essentials",
        tone: "warning",
        href: "/inventory?view=low",
      });
    }
    if (returnsTodayCount > 0) {
      items.push({
        key: "ret",
        count: returnsTodayCount,
        label: "returns today",
        tone: "info",
        href: "/returns",
      });
    }
    return items;
  }, [nearExpiryCount, lowStockRows.length, returnsTodayCount]);

  const controlledSubtitle =
    controlledLowStockCount > 0 || controlledNearExpiryCount > 0
      ? [
          controlledLowStockCount > 0 ? `${controlledLowStockCount} low stock` : null,
          controlledNearExpiryCount > 0 ? `${controlledNearExpiryCount} near expiry` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Controlled low stock / near expiry";

  const within7DaysCount = useMemo(
    () =>
      nearExpiryItems.filter((b) => {
        const days = Math.ceil((new Date(b.expiryDate).getTime() - Date.now()) / 86_400_000);
        return days <= 7;
      }).length,
    [nearExpiryItems],
  );

  return (
    <>
      <HeroBand
        label="Dispensed Today"
        value={dispensedToday}
        scope="Units sold today · vs yesterday"
        sparkline={hourlyUnitsToday}
        trend={
          dispensedTrendLabel
            ? { label: dispensedTrendLabel, direction: dispensedTrendPositive ? "up" : "down" }
            : undefined
        }
        loading={loading}
        secondary={[
          {
            key: "prescriptions",
            label: "Prescriptions to Verify",
            value: pharmacistHolds.length,
            meta:
              pharmacistHolds.length > 0 ? `Oldest waiting ${oldestHoldWait}` : "Nothing waiting right now",
            href: "/pos?panel=holds",
            linkLabel: "Open POS holds",
          },
          {
            key: "controlled",
            label: "Controlled Products Attention",
            value: controlledAttentionCount,
            meta: controlledSubtitle,
            href: "/inventory?controlled=controlled",
            linkLabel: "View inventory",
          },
          {
            key: "expiry",
            label: "Near-Expiry Batches",
            value: nearExpiryCount,
            meta: within7DaysCount > 0 ? `${within7DaysCount} within 7 days` : "None within 7 days",
            href: "/inventory/batches?nearExpiryDays=30",
            linkLabel: "View batches",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No stock or expiry alerts right now" />

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
        title="Pharmacist Quick Actions"
        actions={[
          {
            href: "/pos?panel=holds",
            label: "Pharmacist holds",
            icon: <IconStethoscope size={18} />,
            roles: POS_ROLES,
            tone: "primary",
          },
          {
            href: "/pos?mode=prescription",
            label: "Rx sale mode",
            icon: <IconPill size={18} />,
            roles: POS_ROLES,
            tone: "info",
          },
          {
            href: "/catalog",
            label: "Drug profile lookup",
            icon: <IconSearch size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "success",
          },
          {
            href: "/inventory/batches?nearExpiryDays=30",
            label: "Near expiry",
            icon: <IconCalendar size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
          {
            href: "/inventory?view=low",
            label: "Stock watch",
            icon: <IconAlertTriangle size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "warning",
          },
          {
            href: "/inventory/movements",
            label: "Stock movements",
            icon: <IconPackage size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "success",
          },
          {
            href: "/pos?mode=returns",
            label: "Counter return",
            icon: <IconRotateCcw size={18} />,
            roles: POS_ROLES,
            tone: "danger",
          },
        ]}
      />
    </>
  );
}
