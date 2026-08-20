"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconAlertTriangle,
  IconArchive,
  IconBox,
  IconCalendar,
  IconClipboardList,
  IconPackage,
  IconPlus,
  IconRefresh,
  IconShoppingCart,
  IconTruck,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatExpiry, formatMoney } from "@/app/(app)/inventory/utils";
import { INVENTORY_WRITE_ROLES, OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { MasonryGrid, MasonryItem } from "../components/masonry-grid";
import { PaginationControls } from "../components/pagination-controls";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { StockMovementTrendPanel } from "../components/stock-movement-trend-panel";
import { TopSuppliersPanel } from "../components/top-suppliers-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { useStockValueTrend } from "../hooks/use-stock-value-trend";
import { inventoryHealthScore } from "../lib/health-score";
import { INVENTORY_AI_INSIGHTS } from "../lib/placeholder-data";
import { rowLinkProps } from "../lib/row-link";
import css from "../dashboard.module.css";

type Props = { data: DashboardData };

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return items.slice(safePage * pageSize, safePage * pageSize + pageSize);
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

const SCOPE_LABEL: Record<string, string> = {
  full: "Full-branch count",
  cycle: "Cycle count",
  near_expiry: "Near-expiry count",
  quarantined: "Quarantined items",
  zero_stock: "Zero-stock count",
  custom: "Custom count",
};

export function InventoryClerkDashboard({ data }: Props) {
  const router = useRouter();
  const {
    loading,
    branchId,
    inventory,
    openPos,
    openPoValue,
    overduePos,
    nearExpiryCount,
    nearExpiryItems,
    lowStockRows,
    openTransfers,
    stocktakesInProgress,
    stocktakesActiveCount,
    stocktakesScheduledCount,
    stocktakesCompletedCount,
    stocktakeList,
    openPoListFull,
    fastMoversCount,
  } = data;

  const { data: valueTrend } = useStockValueTrend(branchId);

  const skuCount = inventory?.skuCount ?? 0;
  const healthyPct = skuCount > 0 && inventory ? Math.round((inventory.healthy / skuCount) * 100) : null;

  const health = useMemo(
    () =>
      inventoryHealthScore({
        low: inventory?.lowStock ?? 0,
        dead: 0,
        nearExpiry: nearExpiryCount,
        fast: fastMoversCount ?? 0,
      }),
    [inventory?.lowStock, nearExpiryCount, fastMoversCount],
  );

  const healthSignals = [
    {
      key: "low",
      label: "Low stock",
      value: inventory?.lowStock ?? 0,
      tone: "warning" as const,
      href: "/inventory?view=low",
    },
    {
      key: "out",
      label: "Out of stock",
      value: inventory?.outOfStock ?? 0,
      tone: "danger" as const,
      href: "/inventory?view=out",
    },
    {
      key: "expiry",
      label: "Near expiry ≤30d",
      value: nearExpiryCount,
      tone: "muted" as const,
      href: "/inventory/batches?nearExpiryDays=30",
    },
  ];
  const healthBarMax = Math.max(...healthSignals.map((s) => s.value), 1);
  const mostUrgentKey =
    (inventory?.lowStock ?? 0) >= nearExpiryCount && (inventory?.lowStock ?? 0) >= (inventory?.outOfStock ?? 0)
      ? "low"
      : (inventory?.outOfStock ?? 0) >= nearExpiryCount
        ? "out"
        : "expiry";

  const [batchesPage, setBatchesPage] = useState(0);
  const BATCHES_PAGE_SIZE = 4;
  const batchesPageCount = Math.max(1, Math.ceil(nearExpiryItems.length / BATCHES_PAGE_SIZE));

  const [poPage, setPoPage] = useState(0);
  const PO_PAGE_SIZE = 4;
  const poPageCount = Math.max(1, Math.ceil(openPoListFull.length / PO_PAGE_SIZE));

  const [lowStockPage, setLowStockPage] = useState(0);
  const LOW_STOCK_PAGE_SIZE = 4;
  const lowStockPageCount = Math.max(1, Math.ceil(lowStockRows.length / LOW_STOCK_PAGE_SIZE));

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

      <MasonryGrid>
        <MasonryItem span={2}>
          <StockMovementTrendPanel branchId={branchId} />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Inventory Health" icon={<IconBox size={15} />} compact footerHref="/inventory" footerLabel="Open inventory →">
          {loading && !inventory ? (
            <p className={css.emptyState}>Loading stock health…</p>
          ) : (
            <div className={css.healthBoard}>
              <div className={css.healthTop}>
                <div
                  className={`${css.healthRing} ${css[`healthRing_${health.tone}`]}`}
                  style={{ "--score": loading ? 0 : health.score } as React.CSSProperties}
                >
                  <span>{loading ? "…" : health.score}</span>
                </div>
                <div className={css.healthTopCopy}>
                  <span className={css.healthTopTitle}>{loading ? "…" : health.label}</span>
                  <span className={css.healthTopMeta}>
                    {healthyPct != null ? `${inventory?.healthy ?? 0} of ${skuCount} SKUs healthy` : "—"}
                  </span>
                </div>
              </div>

              <ul className={css.healthFlatList}>
                {healthSignals.map((signal) => {
                  const pct =
                    loading || signal.value === 0
                      ? 0
                      : Math.max(8, Math.round((signal.value / healthBarMax) * 100));
                  return (
                    <li key={signal.key}>
                      <Link href={signal.href} className={css.healthFlatRow}>
                        <span
                          className={`${css.healthSignalIcon} ${css[`healthSignalIcon_${signal.tone}`]}`}
                          aria-hidden
                        >
                          {signal.key === "low" ? (
                            <IconAlertTriangle size={14} strokeWidth={1.75} />
                          ) : signal.key === "out" ? (
                            <IconArchive size={14} strokeWidth={1.75} />
                          ) : (
                            <IconCalendar size={14} strokeWidth={1.75} />
                          )}
                        </span>
                        <span className={css.healthSignalLead}>
                          <span className={css.healthSignalLabel}>{signal.label}</span>
                          {signal.key === mostUrgentKey && signal.value > 0 ? (
                            <span className={css.healthUrgentBadge}>Urgent</span>
                          ) : null}
                        </span>
                        <span className={css.healthSignalTrack}>
                          <span
                            className={`${css.healthSignalFill} ${css[`healthSignalFill_${signal.tone}`]}`}
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className={`${css.healthSignalValue} ${css[`healthSignalValue_${signal.tone}`]}`}>
                          {loading ? "…" : signal.value}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Expiry Watch"
          footerHref="/inventory/batches"
          footerLabel="Open batches →"
          footerMeta={`${nearExpiryCount} near expiry`}
        >
          {nearExpiryItems.length === 0 ? (
            <p className={css.emptyState}>No near-expiry batches in the 30-day window.</p>
          ) : (
            <>
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
                  {paginate(nearExpiryItems, batchesPage, BATCHES_PAGE_SIZE).map((b) => {
                    const days = daysUntil(b.expiryDate);
                    const tone = days < 0 ? "danger" : days <= 14 ? "warning" : "info";
                    return (
                      <tr key={b.batchId} {...rowLinkProps(router, `/catalog?productId=${b.productId}`)}>
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
              <PaginationControls
                page={batchesPage}
                pageCount={batchesPageCount}
                onPrev={() => setBatchesPage((p) => Math.max(0, p - 1))}
                onNext={() => setBatchesPage((p) => Math.min(batchesPageCount - 1, p + 1))}
                rangeLabel={`${batchesPage * BATCHES_PAGE_SIZE + 1}–${Math.min(nearExpiryItems.length, (batchesPage + 1) * BATCHES_PAGE_SIZE)} of ${nearExpiryItems.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Pending POs" footerHref="/purchasing" footerLabel="Open purchasing →" footerMeta={openPos > 0 ? formatMoney(openPoValue) : undefined}>
          {openPoListFull.length === 0 ? (
            <p className={css.emptyState}>No open purchase orders.</p>
          ) : (
            <>
              <ul className={css.pipelineList}>
                {paginate(openPoListFull, poPage, PO_PAGE_SIZE).map((po) => {
                  const lineValue = po.items.reduce(
                    (sum, item) => sum + Number(item.unitCost) * item.orderedQty,
                    0,
                  );
                  return (
                    <li key={po.id}>
                      <Link href={`/purchasing?po=${po.id}`}>
                        <span className={`${css.pipelineIcon} ${css.pipelineIcon_po}`} aria-hidden>
                          <IconShoppingCart size={14} strokeWidth={1.75} />
                        </span>
                        <span className={css.pipelineRowBody}>
                          <strong>{po.poNumber}</strong>
                          <span className={css.muted}>
                            {po.supplier.name}
                            {po.expectedOn ? ` · due ${formatExpiry(po.expectedOn)}` : ""}
                          </span>
                        </span>
                        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.2rem" }}>
                          <StatusBadge status={po.status} />
                          <span className={css.muted}>{formatMoney(lineValue)}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <PaginationControls
                page={poPage}
                pageCount={poPageCount}
                onPrev={() => setPoPage((p) => Math.max(0, p - 1))}
                onNext={() => setPoPage((p) => Math.min(poPageCount - 1, p + 1))}
                rangeLabel={`${poPage * PO_PAGE_SIZE + 1}–${Math.min(openPoListFull.length, (poPage + 1) * PO_PAGE_SIZE)} of ${openPoListFull.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Stock Watch" footerHref="/inventory?view=low" footerLabel="View low stock →" footerMeta={lowStockRows.length > 0 ? `${lowStockRows.length} SKUs` : undefined}>
          {lowStockRows.length === 0 ? (
            <p className={css.emptyState}>Stock levels look healthy.</p>
          ) : (
            <>
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
                  {paginate(lowStockRows, lowStockPage, LOW_STOCK_PAGE_SIZE).map((r) => {
                    const need = Math.max(0, r.product.reorderLevel - r.qtyOnHand);
                    return (
                      <tr key={r.productId} {...rowLinkProps(router, `/catalog?productId=${r.productId}`)}>
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
              <PaginationControls
                page={lowStockPage}
                pageCount={lowStockPageCount}
                onPrev={() => setLowStockPage((p) => Math.max(0, p - 1))}
                onNext={() => setLowStockPage((p) => Math.min(lowStockPageCount - 1, p + 1))}
                rangeLabel={`${lowStockPage * LOW_STOCK_PAGE_SIZE + 1}–${Math.min(lowStockRows.length, (lowStockPage + 1) * LOW_STOCK_PAGE_SIZE)} of ${lowStockRows.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
          <TopSuppliersPanel />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Stocktakes"
          subtitle="Cycle counts · this branch"
          icon={<IconClipboardList size={15} />}
          compact
          footerHref="/stocktakes"
          footerLabel="Open stocktakes →"
        >
          <div className={css.teamStatStrip} style={{ marginBottom: "0.65rem" }}>
            <div className={css.teamStatCell}>
              <div className={css.teamStatCopy}>
                <strong className={css.teamStatValue}>{loading ? "…" : stocktakesActiveCount}</strong>
                <span className={css.teamStatLabel}>In progress</span>
              </div>
            </div>
            <div className={css.teamStatCell}>
              <div className={css.teamStatCopy}>
                <strong className={css.teamStatValue}>{loading ? "…" : stocktakesScheduledCount}</strong>
                <span className={css.teamStatLabel}>Scheduled</span>
              </div>
            </div>
            <div className={css.teamStatCell}>
              <div className={css.teamStatCopy}>
                <strong className={`${css.teamStatValue} ${css.teamStatValue_success}`}>
                  {loading ? "…" : stocktakesCompletedCount}
                </strong>
                <span className={css.teamStatLabel}>Completed</span>
              </div>
            </div>
          </div>

          {stocktakeList.length === 0 ? (
            <p className={css.emptyState}>No stocktakes on record.</p>
          ) : (
            <ul className={css.pipelineList}>
              {stocktakeList.map((s) => (
                <li key={s.id}>
                  <Link href={`/stocktakes/${s.id}`}>
                    <span className={`${css.pipelineIcon} ${css.pipelineIcon_stocktake}`} aria-hidden>
                      <IconClipboardList size={14} strokeWidth={1.75} />
                    </span>
                    <span className={css.pipelineRowBody}>
                      <strong>{s.title || s.stocktakeNumber || "Stocktake"}</strong>
                      <span className={css.muted}>{s.areaLabel || SCOPE_LABEL[s.scope ?? ""] || "Stocktake"}</span>
                    </span>
                    <StatusBadge status={s.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
          <AiInsightsCard insights={INVENTORY_AI_INSIGHTS} footerHref="/purchasing" footerLabel="Open purchasing →" />
        </MasonryItem>
      </MasonryGrid>

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
