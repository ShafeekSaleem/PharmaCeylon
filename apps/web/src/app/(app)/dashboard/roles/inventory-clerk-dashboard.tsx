"use client";

import { useMemo } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconCalendar,
  IconClipboardList,
  IconPackage,
  IconPlus,
  IconRefresh,
  IconTruck,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatExpiry, formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { formatMovementType } from "@/app/(app)/products/utils/format";
import { INVENTORY_WRITE_ROLES, OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleBarChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { INVENTORY_AI_INSIGHTS } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

type Props = { data: DashboardData };

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function InventoryClerkDashboard({ data }: Props) {
  const {
    loading,
    inventory,
    openPos,
    openPoValue,
    overduePos,
    nearExpiryCount,
    nearExpiryItems,
    movements,
    lowStockRows,
    openTransfers,
    stocktakesInProgress,
    openPoList,
  } = data;

  const movementBars = (() => {
    const byDay = new Map<string, { label: string; value: number; sortKey: number }>();
    for (const m of movements) {
      const d = new Date(m.occurredAt);
      const sortKey = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const cur = byDay.get(String(sortKey)) ?? { label, value: 0, sortKey };
      cur.value += Math.abs(m.qtyDelta);
      byDay.set(String(sortKey), cur);
    }
    return [...byDay.values()]
      .sort((a, b) => a.sortKey - b.sortKey)
      .slice(-7)
      .map(({ label, value }) => ({ label, value }));
  })();

  const skuCount = inventory?.skuCount ?? 0;
  const healthyPct = skuCount > 0 && inventory ? Math.round((inventory.healthy / skuCount) * 100) : null;
  const period = inventory?.period ?? inventory?.month;

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
        loading={loading}
        secondary={[
          {
            key: "oos",
            label: "Out of Stock",
            value: inventory?.outOfStock ?? "—",
            meta: "SKUs at zero",
          },
          {
            key: "low",
            label: "Low Stock",
            value: inventory?.lowStock ?? "—",
            meta: "At / below reorder",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No stock or delivery alerts — inventory looks healthy" />

      <div className={css.grid3}>
        <DashboardPanel
          title="Stock Movements"
          className={css.span2}
          footerHref="/inventory/movements"
          footerLabel="View all movements →"
          footerMeta={movements.length > 0 ? `${Math.min(movements.length, 6)} recent` : undefined}
        >
          {movements.length === 0 ? (
            <p className={css.emptyState}>No recent stock movements.</p>
          ) : (
            <>
              {movementBars.length > 0 ? <SimpleBarChart points={movementBars} height={96} /> : null}
              <table className={css.salesTable}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Product</th>
                    <th>Type</th>
                    <th>Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.slice(0, 6).map((m) => (
                    <tr key={m.id}>
                      <td className={css.muted}>{formatRelativeTime(m.occurredAt)}</td>
                      <td>
                        <strong>{m.product.name}</strong>
                        <div className={css.muted}>{m.product.sku}</div>
                      </td>
                      <td className={css.muted}>{formatMovementType(m.movementType)}</td>
                      <td className={m.qtyDelta >= 0 ? css.metricIn : css.metricOut}>
                        {m.qtyDelta >= 0 ? "+" : ""}
                        {m.qtyDelta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </DashboardPanel>

        <DashboardPanel title="Inventory Health" footerHref="/inventory" footerLabel="Open inventory →">
          {loading && !inventory ? (
            <p className={css.emptyState}>Loading stock health…</p>
          ) : (
            <>
              <div className={css.healthPills}>
                <span className={`${css.healthPill} ${css.healthPill_success}`}>
                  Healthy{healthyPct != null ? ` ${healthyPct}%` : ""}
                  <strong>{inventory?.healthy ?? "—"}</strong>
                </span>
                <span className={`${css.healthPill} ${css.healthPill_warning}`}>
                  Low
                  <strong>{inventory?.lowStock ?? "—"}</strong>
                </span>
                <span className={`${css.healthPill} ${css.healthPill_danger}`}>
                  Out
                  <strong>{inventory?.outOfStock ?? "—"}</strong>
                </span>
              </div>
              <div className={css.metricTiles}>
                <div>
                  <span>Received</span>
                  <strong className={css.metricIn}>+{period?.received ?? 0}</strong>
                </div>
                <div>
                  <span>Issued</span>
                  <strong className={css.metricOut}>−{period?.issued ?? 0}</strong>
                </div>
                <div>
                  <span>Adjustments</span>
                  <strong>{period?.adjustments ?? 0}</strong>
                </div>
                <div>
                  <span>Net</span>
                  <strong>{period?.net ?? 0}</strong>
                </div>
              </div>
            </>
          )}
        </DashboardPanel>
      </div>

      <div className={css.grid3}>
        <DashboardPanel
          title="Expiry Watch"
          footerHref="/inventory/batches"
          footerLabel="Open batches →"
          footerMeta={nearExpiryItems.length > 0 ? `${nearExpiryItems.length} shown` : undefined}
        >
          {nearExpiryItems.length === 0 ? (
            <p className={css.emptyState}>No near-expiry batches in the 30-day window.</p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Batch</th>
                  <th>Expiry</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {nearExpiryItems.slice(0, 6).map((b) => {
                  const days = daysUntil(b.expiryDate);
                  const tone = days < 0 ? "danger" : days <= 14 ? "warning" : "info";
                  return (
                    <tr key={b.batchId}>
                      <td>
                        <strong>{b.product.name}</strong>
                        <div className={css.muted}>{b.product.sku}</div>
                      </td>
                      <td className={css.muted}>{b.batchNo}</td>
                      <td>
                        <StatusBadge
                          status={days < 0 ? "failed" : "pending"}
                          label={days < 0 ? "Expired" : formatExpiry(b.expiryDate)}
                          variant={tone === "info" ? "muted" : tone}
                        />
                      </td>
                      <td>{b.qtyOnHand}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DashboardPanel>

        <DashboardPanel title="Pending POs" footerHref="/purchasing" footerLabel="Open purchasing →" footerMeta={openPos > 0 ? formatMoney(openPoValue) : undefined}>
          {openPoList.length === 0 ? (
            <p className={css.emptyState}>No open purchase orders.</p>
          ) : (
            <ul className={css.pipelineList}>
              {openPoList.map((po) => {
                const lineValue = po.items.reduce(
                  (sum, item) => sum + Number(item.unitCost) * item.orderedQty,
                  0,
                );
                return (
                  <li key={po.id}>
                    <div>
                      <strong>{po.poNumber}</strong>
                      <span className={css.muted}>
                        {po.supplier.name}
                        {po.expectedOn ? ` · due ${formatExpiry(po.expectedOn)}` : ""}
                      </span>
                    </div>
                    <div>
                      <StatusBadge status={po.status} />
                      <span className={css.muted}>{formatMoney(lineValue)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DashboardPanel>

        <DashboardPanel title="Stock Watch" footerHref="/inventory?view=low" footerLabel="View low stock →" footerMeta={lowStockRows.length > 0 ? `${lowStockRows.length} SKUs` : undefined}>
          {lowStockRows.length === 0 ? (
            <p className={css.emptyState}>Stock levels look healthy.</p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>On hand</th>
                  <th>Min</th>
                  <th>Need</th>
                </tr>
              </thead>
              <tbody>
                {lowStockRows.slice(0, 6).map((r) => {
                  const need = Math.max(0, r.product.reorderLevel - r.qtyOnHand);
                  return (
                    <tr key={r.productId}>
                      <td>
                        <strong>{r.product.sku}</strong>
                        <div className={css.muted}>{r.product.name}</div>
                      </td>
                      <td>{r.qtyOnHand}</td>
                      <td className={css.muted}>{r.product.reorderLevel}</td>
                      <td>
                        <StatusBadge
                          status={r.qtyOnHand <= 0 ? "failed" : "pending"}
                          label={r.qtyOnHand <= 0 ? "OOS" : need > 0 ? `+${need}` : "Low"}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DashboardPanel>
      </div>

      <AiInsightsCard insights={INVENTORY_AI_INSIGHTS} footerHref="/purchasing" footerLabel="Open purchasing →" />

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
            icon: <IconActivity size={18} />,
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
