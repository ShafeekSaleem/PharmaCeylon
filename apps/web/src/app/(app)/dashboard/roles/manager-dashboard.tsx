"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconAlertTriangle,
  IconArchive,
  IconBox,
  IconCalendar,
  IconChevronDown,
  IconChevronUp,
  IconClipboardList,
  IconPackage,
  IconRefresh,
  IconRotateCcw,
  IconShoppingCart,
  IconTruck,
  IconUsers,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { BusinessOverviewPanel } from "../components/business-overview-panel";
import { CustomerBreakdownPanel } from "../components/customer-breakdown-panel";
import { DashboardPanel } from "../components/dashboard-panel";
import { FootfallPanel } from "../components/footfall-panel";
import { HeroBand } from "../components/hero-band";
import { MasonryGrid, MasonryItem } from "../components/masonry-grid";
import { PaginationControls } from "../components/pagination-controls";
import { ProgressBar } from "../components/progress-bar";
import { QuickActionsBar } from "../components/quick-actions-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { branchTrackStatus, formatYearMonth, monthPaceExpectedPct } from "../lib/branch-status";
import { inventoryHealthScore } from "../lib/health-score";
import { MANAGER_AI_INSIGHTS, type AiInsight } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return items.slice(safePage * pageSize, safePage * pageSize + pageSize);
}

type Props = { data: DashboardData };

export function ManagerDashboard({ data }: Props) {
  const {
    loading,
    branchId,
    inventory,
    todaySalesTotal,
    salesTrendLabel,
    salesTrendPositive,
    todaySalesCount,
    salesTrend7d,
    staffProductivity,
    pendingApprovalsTotal,
    pendingApprovalListFull,
    openTransfers,
    stocktakesInProgress,
    openPoListFull,
    transfers,
    goodsReturns,
    overduePos,
    nearExpiryCount,
    topProductsToday,
    assignedBranchTargets,
    currentBranchPerf,
    branchPerfYearMonth,
    deadStockCount,
    fastMoversCount,
    controlledAttentionCount,
    dispensedToday,
    dispensedTrendLabel,
    dispensedTrendPositive,
  } = data;

  const targetRows = useMemo(
    () =>
      assignedBranchTargets.length > 0
        ? assignedBranchTargets
        : currentBranchPerf
          ? [currentBranchPerf]
          : [],
    [assignedBranchTargets, currentBranchPerf],
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

  /** Individual pending-approval items across POs, transfers & returns — the
   * hero's "Pending Approvals" tile only has a total, this is where the
   * breakdown actually lives (a single href can't represent all three types). */
  type ApprovalItem = {
    key: string;
    kind: "po" | "transfer" | "return";
    number: string;
    detail: string;
    href: string;
  };

  const approvalItems: ApprovalItem[] = useMemo(() => {
    const items: ApprovalItem[] = [];
    for (const po of pendingApprovalListFull) {
      items.push({
        key: `po-${po.id}`,
        kind: "po",
        number: po.poNumber,
        detail: po.supplier.name,
        href: `/purchasing?po=${po.id}`,
      });
    }
    for (const t of transfers.filter((row) => row.status === "requested")) {
      items.push({
        key: `tr-${t.id}`,
        kind: "transfer",
        number: t.transferNumber,
        detail: [t.fromBranch?.name, t.toBranch?.name].filter(Boolean).join(" → ") || "Transfer",
        href: `/transfers?transfer=${t.id}`,
      });
    }
    for (const r of goodsReturns.filter((row) => row.status === "pending_approval")) {
      items.push({
        key: `ret-${r.id}`,
        kind: "return",
        number: r.returnNumber,
        detail: r.type ? r.type.replace(/_/g, " ") : "Return",
        href: `/returns?return=${r.id}`,
      });
    }
    return items;
  }, [pendingApprovalListFull, transfers, goodsReturns]);

  const [approvalsPage, setApprovalsPage] = useState(0);
  const APPROVALS_PAGE_SIZE = 4;
  const approvalsPageCount = Math.max(1, Math.ceil(approvalItems.length / APPROVALS_PAGE_SIZE));

  const pipelineItems = useMemo(
    () => [
      ...openPoListFull.map((po) => ({
        key: `po-${po.id}`,
        kind: "po" as const,
        number: po.poNumber,
        detail: po.supplier.name,
        status: po.status,
        href: `/purchasing?po=${po.id}`,
      })),
      ...transfers
        .filter((t) => ["requested", "approved", "in_transit", "in_progress"].includes(t.status))
        .map((t) => ({
          key: `tr-${t.id}`,
          kind: "transfer" as const,
          number: t.transferNumber,
          detail: [t.fromBranch?.name, t.toBranch?.name].filter(Boolean).join(" → ") || "Transfer",
          status: t.status,
          href: `/transfers?transfer=${t.id}`,
        })),
    ],
    [openPoListFull, transfers],
  );
  const [pipelinePage, setPipelinePage] = useState(0);
  const PIPELINE_PAGE_SIZE = 4;
  const pipelinePageCount = Math.max(1, Math.ceil(pipelineItems.length / PIPELINE_PAGE_SIZE));

  const [productsPage, setProductsPage] = useState(0);
  const PRODUCTS_PAGE_SIZE = 4;
  const productsPageCount = Math.max(1, Math.ceil(topProductsToday.length / PRODUCTS_PAGE_SIZE));

  const liveInsights = useMemo(() => {
    const live: AiInsight[] = [];
    if ((inventory?.lowStock ?? 0) > 0) {
      live.push({
        id: "live-reorder",
        title: "Reorder recommendation",
        detail: `${inventory!.lowStock} low-stock SKUs need replenishment at this branch.`,
        tone: "warning",
        href: "/inventory?view=low",
      });
    }
    if (nearExpiryCount > 0) {
      live.push({
        id: "live-expiry",
        title: "Near-expiry risk",
        detail: `${nearExpiryCount} batches expire within 30 days — prioritize FEFO rotation.`,
        tone: "warning",
        href: "/inventory/batches",
      });
    }
    if (overduePos > 0) {
      live.push({
        id: "live-supply",
        title: "Supply delay",
        detail: `${overduePos} purchase order${overduePos === 1 ? "" : "s"} past expected delivery.`,
        tone: "danger",
        href: "/purchasing?status=overdue",
      });
    }
    return live;
  }, [inventory, nearExpiryCount, overduePos]);

  const allInsights = useMemo(() => {
    const filler = MANAGER_AI_INSIGHTS.filter(
      (s) => !liveInsights.some((l) => l.title === s.title),
    );
    return [...liveInsights, ...filler].slice(0, 4);
  }, [liveInsights]);

  const lowN = inventory?.lowStock ?? 0;
  const deadN = deadStockCount ?? 0;
  const fastN = fastMoversCount ?? 0;
  const health = useMemo(
    () => inventoryHealthScore({ low: lowN, dead: deadN, nearExpiry: nearExpiryCount, fast: fastN }),
    [deadN, fastN, lowN, nearExpiryCount],
  );
  const attentionCount = lowN + deadN + nearExpiryCount;
  const healthBarMax = Math.max(lowN, deadN, nearExpiryCount, 1);
  const mostUrgentKey =
    lowN >= nearExpiryCount && lowN >= deadN
      ? "low"
      : nearExpiryCount >= deadN
        ? "expiry"
        : "dead";
  const healthSignals = [
    { key: "low", label: "Low stock", value: lowN, tone: "danger" as const, href: "/inventory?view=low" },
    { key: "dead", label: "Dead stock", value: deadN, tone: "muted" as const, href: "/reports?tab=dead" },
    {
      key: "expiry",
      label: "Near expiry ≤30d",
      value: nearExpiryCount,
      tone: "warning" as const,
      href: "/inventory/batches?nearExpiryDays=30",
    },
  ];

  const expectedPace = monthPaceExpectedPct();
  const branchStats = useMemo(() => {
    let onTrack = 0;
    let below = 0;
    let bestId: string | null = null;
    let bestPct = -1;
    for (const row of targetRows) {
      const status = branchTrackStatus(row.achievementPct, expectedPace);
      if (status === "on_track") onTrack += 1;
      if (status === "at_risk" || status === "below") below += 1;
      if (row.achievementPct != null && row.achievementPct > bestPct) {
        bestPct = row.achievementPct;
        bestId = row.branchId;
      }
    }
    return { onTrack, below, bestId };
  }, [expectedPace, targetRows]);

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
            href: "/reports",
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
            href: "/reports",
            linkLabel: "View reports",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No operational alerts — branch looks healthy" />

      <MasonryGrid>
        <MasonryItem span={2}>
          <BusinessOverviewPanel
            title="Branch Performance Overview"
            fallbackTrend={salesTrend7d}
            analyticsBranchId={branchId}
          />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Inventory Health" icon={<IconPackage size={15} />} compact>
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
                  {loading
                    ? "Loading signals…"
                    : `${attentionCount} signal${attentionCount === 1 ? "" : "s"} need attention · This branch`}
                </span>
                <span className={css.healthTopValue}>
                  Stock value:{" "}
                  <strong>{loading ? "…" : inventory ? formatMoney(inventory.stockValue) : "—"}</strong>
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
                          <IconBox size={14} strokeWidth={1.75} />
                        ) : signal.key === "dead" ? (
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

            {loading ? null : (
              <Link href="/inventory/movements?category=sales" className={css.healthPositiveCallout}>
                <IconActivity size={16} strokeWidth={2.2} aria-hidden />
                <span className={css.healthPositiveText}>
                  <strong>{fastMoversCount ?? 0}</strong> fast movers today — moving well, no action
                  needed.
                </span>
              </Link>
            )}

            <div className={css.healthActions}>
              <div className={css.healthActionsRow}>
                <Link href="/inventory" className={css.healthReportLink}>
                  View inventory report →
                </Link>
                <div className={css.healthActionBtns}>
                  <Link href="/inventory?view=low" className={`${css.healthActionBtn} ${css.healthActionBtn_primary}`}>
                    <IconBox size={13} strokeWidth={1.75} aria-hidden />
                    Review low stock
                  </Link>
                  <Link
                    href="/inventory/batches?nearExpiryDays=30"
                    className={`${css.healthActionBtn} ${css.healthActionBtn_warning}`}
                  >
                    <IconCalendar size={13} strokeWidth={1.75} aria-hidden />
                    View expiring
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Branch Sales vs Target"
          icon={<IconUsers size={15} />}
          footerMeta={
            branchPerfYearMonth ? (
              <span className={css.monthPill}>
                <IconCalendar size={11} strokeWidth={2} aria-hidden />
                {formatYearMonth(branchPerfYearMonth)}
              </span>
            ) : undefined
          }
        >
          {targetRows.length === 0 ? (
            <p className={css.emptyState}>
              No monthly target assigned yet. Owners set branch targets and assign a manager for
              performance.
            </p>
          ) : (
            <>
              {targetRows.length > 1 ? (
                <div className={css.teamStatStrip} style={{ marginBottom: "0.65rem" }}>
                  <div className={css.teamStatCell}>
                    <div className={css.teamStatCopy}>
                      <strong className={css.teamStatValue}>{targetRows.length}</strong>
                      <span className={css.teamStatLabel}>Branches</span>
                    </div>
                  </div>
                  <div className={css.teamStatCell}>
                    <div className={css.teamStatCopy}>
                      <strong className={`${css.teamStatValue} ${css.teamStatValue_success}`}>
                        {branchStats.onTrack}
                      </strong>
                      <span className={css.teamStatLabel}>On track</span>
                    </div>
                  </div>
                  <div className={css.teamStatCell}>
                    <div className={css.teamStatCopy}>
                      <strong className={`${css.teamStatValue} ${css.teamStatValue_danger}`}>
                        {branchStats.below}
                      </strong>
                      <span className={css.teamStatLabel}>Below target</span>
                    </div>
                  </div>
                </div>
              ) : null}
              <table className={`${css.salesTable} ${css.teamSnapTable}`}>
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>MTD Sales</th>
                    <th>Achievement</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {targetRows.map((row) => {
                    const pct = row.achievementPct;
                    const bar = pct != null ? Math.min(100, Math.max(0, pct)) : 0;
                    const status = branchTrackStatus(pct, expectedPace);
                    const isBest = targetRows.length > 1 && row.branchId === branchStats.bestId;
                    const tone =
                      status === "on_track"
                        ? "success"
                        : status === "at_risk"
                          ? "warning"
                          : status === "below"
                            ? "danger"
                            : "primary";
                    return (
                      <tr key={row.branchId} className={isBest ? css.teamRowBest : undefined}>
                        <td>
                          <span className={css.teamBranchCell}>
                            <span className={css.teamBranchDot} aria-hidden />
                            <span className={css.branchName}>{row.name}</span>
                            {isBest ? <span className={css.teamBestBadge}>Best</span> : null}
                          </span>
                        </td>
                        <td className={css.teamNum}>
                          {formatMoney(row.monthSales)}
                          {row.targetAmount != null ? (
                            <span className={css.teamNumTarget}>/ {formatMoney(row.targetAmount)}</span>
                          ) : null}
                        </td>
                        <td>
                          {pct != null ? (
                            <ProgressBar value={bar} label={`${pct.toFixed(0)}%`} tone={tone} />
                          ) : (
                            <span className={css.muted}>—</span>
                          )}
                        </td>
                        <td>
                          {status === "none" ? (
                            <span className={css.muted}>—</span>
                          ) : (
                            <span className={`${css.teamStatus} ${css[`teamStatus_${status}`]}`}>
                              <span className={css.teamStatusIcon} aria-hidden>
                                {status === "on_track" ? (
                                  <IconChevronUp size={12} strokeWidth={2} />
                                ) : status === "at_risk" ? (
                                  <IconAlertTriangle size={11} strokeWidth={2} />
                                ) : (
                                  <IconChevronDown size={12} strokeWidth={2} />
                                )}
                              </span>
                              {status === "on_track"
                                ? "On track"
                                : status === "at_risk"
                                  ? "At risk"
                                  : "Below target"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Staff Productivity">
          {staffProductivity.length === 0 ? (
            <p className={css.emptyState}>No counter activity yet today.</p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>Staff</th>
                  <th>Sales</th>
                  <th>Txns</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {staffProductivity.map((row) => {
                  const share = todaySalesTotal > 0 ? Math.round((row.sales / todaySalesTotal) * 100) : 0;
                  const avg = row.transactions > 0 ? row.sales / row.transactions : 0;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div>{row.name}</div>
                        <span className={css.muted}>Avg {formatMoney(avg)}</span>
                      </td>
                      <td>{formatMoney(row.sales)}</td>
                      <td>{row.transactions}</td>
                      <td>
                        <ProgressBar value={share} label={`${share}%`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
          <CustomerBreakdownPanel branchId={branchId} />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Transfer & PO Pipeline" footerHref="/purchasing" footerLabel="Open pipeline →">
          {pipelineItems.length === 0 ? (
            <p className={css.emptyState}>No open pipeline items.</p>
          ) : (
            <>
              <ul className={css.pipelineList}>
                {paginate(pipelineItems, pipelinePage, PIPELINE_PAGE_SIZE).map((item) => (
                  <li key={item.key}>
                    <Link href={item.href}>
                      <span
                        className={`${css.pipelineIcon} ${css[`pipelineIcon_${item.kind === "po" ? "po" : "transfer"}`]}`}
                        aria-hidden
                      >
                        {item.kind === "po" ? (
                          <IconShoppingCart size={14} strokeWidth={1.75} />
                        ) : (
                          <IconTruck size={14} strokeWidth={1.75} />
                        )}
                      </span>
                      <span className={css.pipelineRowBody}>
                        <strong>{item.number}</strong>
                        <span className={css.muted}>{item.detail}</span>
                      </span>
                      <StatusBadge status={item.status} />
                    </Link>
                  </li>
                ))}
              </ul>
              <PaginationControls
                page={pipelinePage}
                pageCount={pipelinePageCount}
                onPrev={() => setPipelinePage((p) => Math.max(0, p - 1))}
                onNext={() => setPipelinePage((p) => Math.min(pipelinePageCount - 1, p + 1))}
                rangeLabel={`${pipelinePage * PIPELINE_PAGE_SIZE + 1}–${Math.min(pipelineItems.length, (pipelinePage + 1) * PIPELINE_PAGE_SIZE)} of ${pipelineItems.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Top Products Today" footerHref="/reports" footerLabel="Open reports →">
          {topProductsToday.length === 0 ? (
            <p className={css.emptyState}>No sales recorded yet today.</p>
          ) : (
            <>
              <ul className={css.topProductsList}>
                {paginate(topProductsToday, productsPage, PRODUCTS_PAGE_SIZE).map((p, i) => {
                  const rank = productsPage * PRODUCTS_PAGE_SIZE + i;
                  return (
                    <li key={p.sku}>
                      <Link href={`/products/${p.id}`} className={css.topProductRow}>
                        <span className={`${css.topProductRank}${rank === 0 ? ` ${css.topProductRank_lead}` : ""}`}>
                          {rank + 1}
                        </span>
                        <span className={css.topProductBody}>
                          <strong>{p.name}</strong>
                          <span>{p.sku}</span>
                        </span>
                        <span className={css.topProductQty}>{p.qty} sold</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
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
          <FootfallPanel branchId={branchId} />
        </MasonryItem>

        <MasonryItem>
          <AiInsightsCard insights={allInsights} footerHref="/reports" />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Pending Approvals" icon={<IconClipboardList size={15} />}>
          {approvalItems.length === 0 ? (
            <p className={css.emptyState}>No pending approvals right now.</p>
          ) : (
            <>
              <ul className={css.pipelineList}>
                {paginate(approvalItems, approvalsPage, APPROVALS_PAGE_SIZE).map((item) => (
                  <li key={item.key}>
                    <Link href={item.href}>
                      <span
                        className={`${css.pipelineIcon} ${css[`pipelineIcon_${item.kind}`]}`}
                        aria-hidden
                      >
                        {item.kind === "po" ? (
                          <IconShoppingCart size={14} strokeWidth={1.75} />
                        ) : item.kind === "transfer" ? (
                          <IconTruck size={14} strokeWidth={1.75} />
                        ) : (
                          <IconRotateCcw size={14} strokeWidth={1.75} />
                        )}
                      </span>
                      <span className={css.pipelineRowBody}>
                        <strong>{item.number}</strong>
                        <span className={css.muted}>{item.detail}</span>
                      </span>
                      <span className={css.approvalKindPill}>
                        {item.kind === "po" ? "PO" : item.kind === "transfer" ? "Transfer" : "Return"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <PaginationControls
                page={approvalsPage}
                pageCount={approvalsPageCount}
                onPrev={() => setApprovalsPage((p) => Math.max(0, p - 1))}
                onNext={() => setApprovalsPage((p) => Math.min(approvalsPageCount - 1, p + 1))}
                rangeLabel={`${approvalsPage * APPROVALS_PAGE_SIZE + 1}–${Math.min(approvalItems.length, (approvalsPage + 1) * APPROVALS_PAGE_SIZE)} of ${approvalItems.length}`}
              />
            </>
          )}
        </DashboardPanel>
        </MasonryItem>
      </MasonryGrid>

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
