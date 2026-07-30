"use client";

import Link from "next/link";
import { Alert } from "@/components/alert";
import {
  IconActivity,
  IconAlertTriangle,
  IconBox,
  IconClipboardList,
  IconPackage,
  IconShoppingCart,
  IconShoppingBag,
  IconTruck,
} from "@/components/icons";
import { PageHeader, StatCard } from "@/components/ui";
import { formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { RoleLink } from "@/components/role-access";
import { OPERATIONS_ROLES, POS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import css from "./dashboard.module.css";
import { useDashboardData } from "./hooks/use-dashboard-data";

export default function DashboardPage() {
  const {
    branchId,
    loading,
    error,
    inventory,
    greeting,
    canViewPurchasing,
    todaySalesCount,
    todaySalesTotal,
    monthSalesCount,
    monthSalesTotal,
    recentSales,
    openPos,
    overduePos,
    pendingApproval,
    reorderCount,
    topReorder,
  } = useDashboardData();

  const alerts = [
    overduePos > 0
      ? {
          key: "overdue",
          label: "Overdue deliveries",
          count: overduePos,
          tone: "danger" as const,
          href: "/purchasing",
        }
      : null,
    (inventory?.lowStock ?? 0) > 0
      ? {
          key: "low",
          label: "Low-stock SKUs",
          count: inventory!.lowStock,
          tone: "warning" as const,
          href: "/inventory?view=low",
        }
      : null,
    (inventory?.nearExpiryProducts ?? 0) > 0
      ? {
          key: "expiry",
          label: "Products expiring soon",
          count: inventory!.nearExpiryProducts,
          tone: "warning" as const,
          href: "/inventory/batches",
        }
      : null,
    pendingApproval > 0
      ? {
          key: "pending",
          label: "POs pending approval",
          count: pendingApproval,
          tone: "warning" as const,
          href: "/purchasing",
        }
      : null,
    reorderCount > 0
      ? {
          key: "reorder",
          label: "Reorder suggestions",
          count: reorderCount,
          tone: "warning" as const,
          href: "/analytics",
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    label: string;
    count: number;
    tone: "danger" | "warning";
    href: string;
  }>;

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        description={`Welcome back, ${greeting}. Here's what's happening at your branch today.`}
      />

      {!branchId ? (
        <Alert variant="warning">Select a branch in the header to load dashboard metrics.</Alert>
      ) : null}

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div className={css.kpiRow}>
        <StatCard
          title="Sales today"
          value={loading ? "…" : formatMoney(todaySalesTotal)}
          subtitle={`${todaySalesCount} invoice${todaySalesCount === 1 ? "" : "s"}`}
          icon={<IconShoppingCart size={16} />}
          iconTone="primary"
        />
        <StatCard
          title="Sales (30 days)"
          value={loading ? "…" : formatMoney(monthSalesTotal)}
          subtitle={`${monthSalesCount} posted sale${monthSalesCount === 1 ? "" : "s"}`}
          icon={<IconActivity size={16} />}
          iconTone="success"
        />
        <StatCard
          title="Stock value"
          value={loading ? "…" : inventory ? formatMoney(inventory.stockValue) : "—"}
          subtitle={
            inventory ? `${inventory.totalUnits} units · ${inventory.skuCount} SKUs` : undefined
          }
          icon={<IconPackage size={16} />}
          iconTone="info"
        />
        <StatCard
          title="Low stock"
          value={loading ? "…" : (inventory?.lowStock ?? "—")}
          subtitle={
            inventory?.outOfStock
              ? `${inventory.outOfStock} out of stock`
              : "At or below reorder level"
          }
          icon={<IconAlertTriangle size={16} />}
          iconTone="warning"
        />
        <StatCard
          title="Expiring soon"
          value={loading ? "…" : (inventory?.nearExpiryProducts ?? "—")}
          subtitle={
            inventory ? `${inventory.nearExpiry} batches ≤30 days` : undefined
          }
          icon={<IconBox size={16} />}
          iconTone="warning"
        />
        {canViewPurchasing ? (
          <StatCard
            title="Open POs"
            value={loading ? "…" : openPos}
            subtitle={overduePos > 0 ? `${overduePos} overdue` : "Draft through partial"}
            icon={<IconTruck size={16} />}
            iconTone="primary"
          />
        ) : null}
      </div>

      <div className={css.dashboard}>
        <div className={css.mainCol}>
          <section className={css.panel}>
            <h2 className={css.panelTitle}>Recent sales</h2>
            {loading ? (
              <p className={css.emptyState}>Loading sales…</p>
            ) : recentSales.length === 0 ? (
              <p className={css.emptyState}>No posted sales for this branch yet.</p>
            ) : (
              <table className={css.salesTable}>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>When</th>
                    <th>Items</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSales.map((sale) => (
                    <tr key={sale.id}>
                      <td>
                        <Link href="/pos" className={css.invoiceLink}>
                          {sale.invoiceNo}
                        </Link>
                      </td>
                      <td className={css.muted}>{formatRelativeTime(sale.soldAt)}</td>
                      <td>
                        {sale.items
                          .map((item) => `${item.qty}× ${item.product.sku}`)
                          .join(", ")}
                      </td>
                      <td>{formatMoney(sale.grandTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <aside className={css.sideCol}>
          <section className={css.panel}>
            <h2 className={css.panelTitle}>Alerts</h2>
            {alerts.length === 0 ? (
              <p className={css.emptyState}>No active alerts — everything looks healthy.</p>
            ) : (
              <ul className={css.alertList}>
                {alerts.map((alert) => (
                  <li key={alert.key}>
                    <Link
                      href={alert.href}
                      className={`${css.alertItem} ${
                        alert.tone === "danger" ? css.alertItemDanger : css.alertItemWarning
                      }`}
                    >
                      <span>{alert.label}</span>
                      <span className={css.alertCount}>{alert.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={css.panel}>
            <h2 className={css.panelTitle}>Quick actions</h2>
            <div className={css.quickActions}>
              <RoleLink href="/pos" roles={POS_ROLES} className={css.quickAction}>
                <IconShoppingCart size={16} />
                Open POS
              </RoleLink>
              <RoleLink href="/inventory" roles={OPERATIONS_ROLES} className={css.quickAction}>
                <IconPackage size={16} />
                Inventory
              </RoleLink>
              <RoleLink href="/purchasing" roles={PURCHASING_ROLES} className={css.quickAction}>
                <IconTruck size={16} />
                Purchasing
              </RoleLink>
              <RoleLink href="/products" className={css.quickAction}>
                <IconShoppingBag size={16} />
                Products
              </RoleLink>
              <RoleLink href="/inventory?openAdjustment=1" roles={OPERATIONS_ROLES} className={css.quickAction}>
                <IconClipboardList size={16} />
                Stock adjustment
              </RoleLink>
            </div>
          </section>

          {inventory ? (
            <section className={css.panel}>
              <h2 className={css.panelTitle}>This month · inventory</h2>
              <div className={css.summaryGrid}>
                <div className={css.summaryRow}>
                  <span className={css.summaryLabel}>Received</span>
                  <span className={`${css.summaryValue} ${css.metricIn}`}>
                    +{inventory.period?.received ?? inventory.month.received}
                  </span>
                </div>
                <div className={css.summaryRow}>
                  <span className={css.summaryLabel}>Issued</span>
                  <span className={`${css.summaryValue} ${css.metricOut}`}>
                    −{inventory.period?.issued ?? inventory.month.issued}
                  </span>
                </div>
                <div className={css.summaryRow}>
                  <span className={css.summaryLabel}>Net movement</span>
                  <span
                    className={`${css.summaryValue} ${
                      (inventory.period?.net ?? inventory.month.net) >= 0
                        ? css.metricIn
                        : css.metricOut
                    }`}
                  >
                    {(inventory.period?.net ?? inventory.month.net) >= 0 ? "+" : ""}
                    {inventory.period?.net ?? inventory.month.net}
                  </span>
                </div>
              </div>
            </section>
          ) : null}

          {topReorder.length > 0 ? (
            <section className={css.panel}>
              <h2 className={css.panelTitle}>Reorder suggestions</h2>
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
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
