"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconAlertTriangle,
  IconCalendar,
  IconPackage,
  IconPill,
  IconRotateCcw,
  IconSearch,
  IconStethoscope,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatExpiry, formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, POS_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { MasonryGrid, MasonryItem } from "../components/masonry-grid";
import { MetricCell, pctChange } from "../components/metric-cell";
import { PaginationControls } from "../components/pagination-controls";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleBarChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { PHARMACIST_AI_INSIGHTS } from "../lib/placeholder-data";
import { rowLinkProps } from "../lib/row-link";
import css from "../dashboard.module.css";

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return items.slice(safePage * pageSize, safePage * pageSize + pageSize);
}

type Props = { data: DashboardData };

const AVATAR_TONE_CLASS = [
  css.avatarTone_0,
  css.avatarTone_1,
  css.avatarTone_2,
  css.avatarTone_3,
  css.avatarTone_4,
  css.avatarTone_5,
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

function avatarToneClass(name: string): string {
  const n = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return AVATAR_TONE_CLASS[n % AVATAR_TONE_CLASS.length]!;
}

function waitMinutes(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

type QueueBucket = "urgent" | "awaiting" | "ready";

function queueBucket(minutes: number): QueueBucket {
  if (minutes > 30) return "urgent";
  if (minutes >= 10) return "awaiting";
  return "ready";
}

const QUEUE_BUCKET_LABEL: Record<QueueBucket, string> = {
  urgent: "Urgent",
  awaiting: "Awaiting Rx",
  ready: "Ready",
};

const QUEUE_BUCKET_VARIANT: Record<QueueBucket, "danger" | "info" | "success"> = {
  urgent: "danger",
  awaiting: "info",
  ready: "success",
};

function expiryTone(iso: string): "danger" | "warning" | "info" {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "danger";
  if (days <= 30) return "warning";
  return "info";
}

function expiryLabel(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "Expired";
  if (days <= 30) return "Within 30 days";
  if (days <= 90) return "Within 90 days";
  return formatExpiry(iso);
}

export function PharmacistDashboard({ data }: Props) {
  const router = useRouter();
  const {
    loading,
    pharmacistHolds,
    nearExpiryCount,
    nearExpiryItems,
    dispensedToday,
    dispensedYesterday,
    dispensedTrendPct,
    dispensedTrendLabel,
    dispensedTrendPositive,
    hourlyUnitsToday,
    todaySalesCount,
    yesterdaySalesCount,
    topProductsToday,
    lowStockRows,
    controlledAttentionCount,
    controlledLowStockCount,
    controlledNearExpiryCount,
    returnsTodayCount,
  } = data;

  const peakHour = hourlyUnitsToday.reduce(
    (best, p) => (p.value > best.value ? p : best),
    hourlyUnitsToday[0] ?? { label: "—", value: 0 },
  );

  const oldestHoldWait = useMemo(() => {
    if (pharmacistHolds.length === 0) return null;
    const oldest = pharmacistHolds.reduce((a, b) =>
      new Date(a.createdAt) < new Date(b.createdAt) ? a : b,
    );
    return formatRelativeTime(oldest.createdAt);
  }, [pharmacistHolds]);

  // Verification queue: age-bucket the same pharmacistHolds list by wait time.
  const queueRows = useMemo(
    () =>
      [...pharmacistHolds]
        .map((h) => ({ ...h, bucket: queueBucket(waitMinutes(h.createdAt)) }))
        .sort((a, b) => waitMinutes(b.createdAt) - waitMinutes(a.createdAt)),
    [pharmacistHolds],
  );

  const [holdsPage, setHoldsPage] = useState(0);
  const HOLDS_PAGE_SIZE = 4;
  const holdsPageCount = Math.max(1, Math.ceil(queueRows.length / HOLDS_PAGE_SIZE));

  const [productsPage, setProductsPage] = useState(0);
  const PRODUCTS_PAGE_SIZE = 6;
  const productsPageCount = Math.max(1, Math.ceil(topProductsToday.length / PRODUCTS_PAGE_SIZE));

  const [batchesPage, setBatchesPage] = useState(0);
  const BATCHES_PAGE_SIZE = 4;
  const batchesPageCount = Math.max(1, Math.ceil(nearExpiryItems.length / BATCHES_PAGE_SIZE));

  const [lowStockPage, setLowStockPage] = useState(0);
  const LOW_STOCK_PAGE_SIZE = 4;
  const lowStockPageCount = Math.max(1, Math.ceil(lowStockRows.length / LOW_STOCK_PAGE_SIZE));

  // Controlled Drug Activity: same shape as the Inventory Health signal rows
  // used on owner/manager dashboards (healthFlatList).
  const controlledBarMax = Math.max(
    controlledAttentionCount,
    controlledLowStockCount,
    controlledNearExpiryCount,
    1,
  );
  const controlledMostUrgentKey =
    controlledAttentionCount >= controlledLowStockCount && controlledAttentionCount >= controlledNearExpiryCount
      ? "flagged"
      : controlledLowStockCount >= controlledNearExpiryCount
        ? "lowstock"
        : "nearexpiry";
  const controlledSignals = [
    {
      key: "flagged",
      label: "CD alerts flagged",
      value: controlledAttentionCount,
      tone: "danger" as const,
      href: "/inventory?controlled=controlled",
    },
    {
      key: "lowstock",
      label: "CD low stock",
      value: controlledLowStockCount,
      tone: "warning" as const,
      href: "/inventory?view=low&controlled=controlled",
    },
    {
      key: "nearexpiry",
      label: "CD near expiry",
      value: controlledNearExpiryCount,
      tone: "muted" as const,
      href: "/inventory/batches?nearExpiryDays=30&controlled=controlled",
    },
  ];

  // Dispensing throughput trends vs yesterday (same shape as Shift Performance on the cashier dashboard).
  const avgUnitsPerRx = todaySalesCount > 0 ? dispensedToday / todaySalesCount : 0;
  const avgUnitsPerRxYesterday =
    yesterdaySalesCount > 0 ? dispensedYesterday / yesterdaySalesCount : 0;
  const avgPerRxTrendPct =
    yesterdaySalesCount > 0 ? pctChange(avgUnitsPerRx, avgUnitsPerRxYesterday) : null;

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

      <MasonryGrid>
        <MasonryItem span={2}>
        <DashboardPanel
          title="Prescription Verification Queue"
          footerHref="/pos"
          footerLabel="Open POS holds →"
          footerMeta={`${pharmacistHolds.length} waiting`}
        >
          {pharmacistHolds.length === 0 ? (
            <p className={css.emptyState}>No POS holds currently flagged for pharmacist review.</p>
          ) : (
            <>
              <table className={css.salesTable}>
                <thead>
                  <tr>
                    <th>Hold / label</th>
                    <th>Ref</th>
                    <th>Items</th>
                    <th>Total</th>
                    <th>Held by</th>
                    <th>Time</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {paginate(queueRows, holdsPage, HOLDS_PAGE_SIZE).map((h) => {
                    const name = h.label || h.heldByName;
                    return (
                      <tr key={h.id} {...rowLinkProps(router, `/pos?panel=holds&holdId=${h.id}`)}>
                        <td>
                          <span className={css.avatarRow}>
                            <span className={`${css.avatarChip} ${avatarToneClass(name)}`}>
                              {initials(name)}
                            </span>
                            {name}
                          </span>
                        </td>
                        <td>
                          <span className={css.invoiceLink}>{h.holdRef}</span>
                        </td>
                        <td>{h.itemCount}</td>
                        <td className={css.teamNum}>{formatMoney(h.total)}</td>
                        <td className={css.muted}>{h.heldByName}</td>
                        <td className={css.muted}>{formatRelativeTime(h.createdAt)}</td>
                        <td>
                          <StatusBadge
                            status="pending"
                            label={QUEUE_BUCKET_LABEL[h.bucket]}
                            variant={QUEUE_BUCKET_VARIANT[h.bucket]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <PaginationControls
                page={holdsPage}
                pageCount={holdsPageCount}
                onPrev={() => setHoldsPage((p) => Math.max(0, p - 1))}
                onNext={() => setHoldsPage((p) => Math.min(holdsPageCount - 1, p + 1))}
                rangeLabel={`${holdsPage * HOLDS_PAGE_SIZE + 1}–${Math.min(queueRows.length, (holdsPage + 1) * HOLDS_PAGE_SIZE)} of ${queueRows.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Drug Interaction / CDS"
          headerRight={<span className={css.placeholderBadge}>Sample</span>}
          footerLabel="Clinical screening coming soon"
          footerMeta="Not connected"
        >
          <ul className={css.aiList}>
            <li className={`${css.aiItem} ${css.aiTone_danger}`}>
              <div>
                <strong>Amoxicillin + Warfarin</strong>
                <p>Bleeding risk increased — sample interaction.</p>
              </div>
              <StatusBadge status="pending" label="High" variant="danger" />
            </li>
            <li className={`${css.aiItem} ${css.aiTone_warning}`}>
              <div>
                <strong>Allergy flag</strong>
                <p>Patient allergy matching not wired.</p>
              </div>
              <StatusBadge status="pending" label="Medium" variant="warning" />
            </li>
            <li className={`${css.aiItem} ${css.aiTone_info}`}>
              <div>
                <strong>Duplicate therapy</strong>
                <p>Screening pipeline not connected yet.</p>
              </div>
              <StatusBadge status="pending" label="Low" variant="success" />
            </li>
          </ul>
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Dispensing Throughput (Today)"
          compact
          footerHref="/pos"
          footerLabel="Open POS →"
          footerMeta={peakHour.value > 0 ? `Peak hour: ${peakHour.label}` : undefined}
        >
          <SimpleBarChart points={hourlyUnitsToday} height={140} />
          <div className={css.overviewChartsSummary} style={{ marginTop: "0.5rem" }}>
            <MetricCell
              label="Total dispensed"
              value={loading ? "…" : `${dispensedToday.toLocaleString()} units`}
              icon={<IconPackage size={16} strokeWidth={1.75} />}
              iconTone="bills"
              trend={
                dispensedTrendPct != null ? { pct: dispensedTrendPct, compareLabel: "vs Yesterday" } : undefined
              }
            />
            <MetricCell
              label="Avg per Rx"
              value={loading ? "…" : `${avgUnitsPerRx.toFixed(1)} units`}
              icon={<IconPill size={16} strokeWidth={1.75} />}
              iconTone="avg"
              trend={
                avgPerRxTrendPct != null ? { pct: avgPerRxTrendPct, compareLabel: "vs Yesterday" } : undefined
              }
            />
            <MetricCell
              label="Peak hour"
              value={loading ? "…" : peakHour.value > 0 ? `${peakHour.label} · ${peakHour.value} units` : "—"}
              icon={<IconStethoscope size={16} strokeWidth={1.75} />}
              iconTone="peak"
            />
          </div>
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Controlled Drug Activity"
          subtitle="Today · scheduled substances"
          footerHref="/inventory?controlled=controlled"
          footerLabel="Review controlled inventory →"
        >
          <ul className={css.healthFlatList}>
            {controlledSignals.map((signal) => {
              const pct =
                loading || signal.value === 0
                  ? 0
                  : Math.max(8, Math.round((signal.value / controlledBarMax) * 100));
              return (
                <li key={signal.key}>
                  <Link href={signal.href} className={css.healthFlatRow}>
                    <span
                      className={`${css.healthSignalIcon} ${css[`healthSignalIcon_${signal.tone}`]}`}
                      aria-hidden
                    >
                      {signal.key === "flagged" ? (
                        <IconAlertTriangle size={14} strokeWidth={1.75} />
                      ) : signal.key === "lowstock" ? (
                        <IconPackage size={14} strokeWidth={1.75} />
                      ) : (
                        <IconCalendar size={14} strokeWidth={1.75} />
                      )}
                    </span>
                    <span className={css.healthSignalLead}>
                      <span className={css.healthSignalLabel}>{signal.label}</span>
                      {signal.key === controlledMostUrgentKey && signal.value > 0 ? (
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
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Frequently Dispensed" footerHref="/pos" footerLabel="Open POS →">
          {topProductsToday.length === 0 ? (
            <p className={css.emptyState}>No units sold today yet.</p>
          ) : (
            <>
              <div className={`${css.productStrip} ${css.productStripWrap}`}>
                {paginate(topProductsToday, productsPage, PRODUCTS_PAGE_SIZE).map((p) => (
                  <Link key={p.sku} href={`/products/${p.id}`} className={css.productChip}>
                    <span className={css.productAvatar} aria-hidden>
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className={css.productChipBody}>
                      <strong>{p.name}</strong>
                      <span>{p.sku}</span>
                      <em>{p.qty} units</em>
                    </div>
                  </Link>
                ))}
              </div>
              <PaginationControls
                page={productsPage}
                pageCount={productsPageCount}
                onPrev={() => setProductsPage((p) => Math.max(0, p - 1))}
                onNext={() => setProductsPage((p) => Math.min(productsPageCount - 1, p + 1))}
                rangeLabel={`${productsPage * PRODUCTS_PAGE_SIZE + 1}–${Math.min(topProductsToday.length, (productsPage + 1) * PRODUCTS_PAGE_SIZE)} of ${topProductsToday.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Batch & Expiry Monitor"
          footerHref="/inventory/batches"
          footerLabel="View all batches →"
          footerMeta={`${nearExpiryCount} near expiry`}
        >
          {nearExpiryItems.length === 0 ? (
            <p className={css.emptyState}>No batches expiring within 30 days.</p>
          ) : (
            <>
              <table className={css.salesTable}>
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th>Batch</th>
                    <th>Expiry</th>
                    <th>Status</th>
                    <th>Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {paginate(nearExpiryItems, batchesPage, BATCHES_PAGE_SIZE).map((b) => (
                    <tr
                      key={b.batchId}
                      {...rowLinkProps(router, `/catalog?productId=${b.productId}`)}
                    >
                      <td>
                        {b.product.name}
                        {b.product.isControlled ? <span className={css.muted}> · CD</span> : null}
                      </td>
                      <td>{b.batchNo}</td>
                      <td className={css.muted}>{formatExpiry(b.expiryDate)}</td>
                      <td>
                        <StatusBadge
                          status="pending"
                          label={expiryLabel(b.expiryDate)}
                          variant={expiryTone(b.expiryDate)}
                        />
                      </td>
                      <td>{b.qtyOnHand}</td>
                    </tr>
                  ))}
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
        <DashboardPanel title="Stock Watch — Therapeutic Essentials" footerHref="/inventory?view=low" footerLabel="Open inventory →">
          {lowStockRows.length === 0 ? (
            <p className={css.emptyState}>No low / out-of-stock essentials right now.</p>
          ) : (
            <>
              <table className={css.salesTable}>
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th>Available</th>
                    <th>Min</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {paginate(lowStockRows, lowStockPage, LOW_STOCK_PAGE_SIZE).map((r) => (
                    <tr key={r.productId} {...rowLinkProps(router, `/catalog?productId=${r.productId}`)}>
                      <td>
                        {r.product.name}
                        {r.product.isControlled ? <span className={css.muted}> · CD</span> : null}
                      </td>
                      <td>{r.qtyOnHand}</td>
                      <td>{r.product.reorderLevel}</td>
                      <td>
                        <StatusBadge
                          status={r.qtyOnHand <= 0 ? "failed" : "pending"}
                          label={r.qtyOnHand <= 0 ? "Out of Stock" : "Low Stock"}
                          variant={r.qtyOnHand <= 0 ? "danger" : "warning"}
                        />
                      </td>
                    </tr>
                  ))}
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
          <AiInsightsCard title="AI Clinical Insights" insights={PHARMACIST_AI_INSIGHTS} />
        </MasonryItem>
      </MasonryGrid>

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
