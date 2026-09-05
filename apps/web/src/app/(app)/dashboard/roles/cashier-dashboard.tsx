"use client";

import { useMemo } from "react";
import {
  IconBarcodeScan,
  IconPause,
  IconReceipt,
  IconRotateCcw,
  IconSearch,
  IconShoppingCart,
  IconUsers,
} from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { CATALOG_ROLES, POS_ROLES, RETURNS_ROLES } from "@/lib/role-access";
import {
  AttentionTicker,
  type TickerItem,
} from "../components/attention-ticker";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import { useCustomerBreakdown } from "../hooks/use-customer-breakdown";
import css from "../dashboard.module.css";
import type { WidgetDef } from "../widgets/types";

type Props = {
  data: DashboardData;
  catalog: WidgetDef[];
  layout: UseDashboardLayoutResult;
};

export function CashierDashboard({ data, catalog, layout }: Props) {
  const {
    loading,
    todaySalesTotal,
    todaySalesCount,
    salesTrendLabel,
    salesTrendPositive,
    billsTrendLabel,
    billsTrendPositive,
    holdCount,
    holdValue,
    pharmacistHolds,
    returnsTodayCount,
    returnsTodayTotal,
    hourlyToday,
    lowStockRows,
    branchId,
  } = data;

  const rxWaiting = pharmacistHolds.length;
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
  }, [
    rxWaiting,
    holdCount,
    lowStockRows.length,
    returnsTodayCount,
    returnsTodayTotal,
  ]);

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
            ? {
                label: salesTrendLabel,
                direction: salesTrendPositive ? "up" : "down",
              }
            : undefined
        }
        secondary={[
          {
            key: "bills",
            label: "Bills Processed",
            value: todaySalesCount,
            meta: "Posted today",
            trend: billsTrendLabel
              ? {
                  label: billsTrendLabel,
                  direction: billsTrendPositive ? "up" : "down",
                }
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
                  <i
                    className={css.heroBreakdownDot}
                    style={{ background: "var(--pc-muted-fg)" }}
                  />
                  {breakdown.walkIn} walk-in
                </span>
                <span className={css.heroBreakdownItem}>
                  <i
                    className={css.heroBreakdownDot}
                    style={{ background: "var(--pc-primary)" }}
                  />
                  {breakdown.registered} registered
                </span>
              </span>
            ) : undefined,
            href: "/pos?panel=customer",
            linkLabel: "Find customer",
          },
        ]}
      />

      <AttentionTicker
        items={tickerItems}
        loading={loading}
        allClearText="No counter alerts — all clear"
      />

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
            href: "/products?scope=reference",
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
