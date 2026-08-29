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
  IconChevronRight,
  IconChevronUp,
  IconClipboardList,
  IconEdit,
  IconPackage,
  IconRotateCcw,
  IconShoppingCart,
  IconTruck,
  IconUserPlus,
  IconUsers,
} from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { BranchSalesTrendPanel } from "../components/branch-sales-trend-panel";
import { BusinessOverviewPanel } from "../components/business-overview-panel";
import { CashFlowPanel } from "../components/cash-flow-panel";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { MasonryGrid, MasonryItem } from "../components/masonry-grid";
import { PaginationControls } from "../components/pagination-controls";
import { ProgressBar } from "../components/progress-bar";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SetBranchTargetsModal } from "../components/set-branch-targets-modal";
import { TopSuppliersPanel } from "../components/top-suppliers-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { branchColor } from "../lib/branch-colors";
import { branchTrackStatus, formatYearMonth, monthPaceExpectedPct } from "../lib/branch-status";
import { inventoryHealthScore } from "../lib/health-score";
import { OWNER_AI_INSIGHTS, type AiInsight } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return items.slice(safePage * pageSize, safePage * pageSize + pageSize);
}

type Props = { data: DashboardData };

export function OwnerDashboard({ data }: Props) {
  const {
    loading,
    ownerLowStock,
    ownerStockValue,
    ownerKpisPending,
    nearExpiryCount,
    salesTrend7d,
    overduePos,
    pendingApproval,
    branchPerformance,
    scopedBranchPerformance,
    branchPerfYearMonth,
    financial,
    deadStockCount,
    fastMoversCount,
    controlledAttentionCount,
    openTransfers,
    ownerScopeLabel,
    analyticsBranchId,
    inventoryImprovedCount,
    inventoryImprovedDays,
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
    transfers,
    goodsReturns,
    reload,
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

  const [targetsOpen, setTargetsOpen] = useState(false);
  const yearMonth =
    branchPerfYearMonth ??
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const teamRows = scopedBranchPerformance ?? branchPerformance;
  const scopePhrase = ownerScopeLabel.toLowerCase();
  const kpisLoading = loading || ownerKpisPending;

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

  /** Individual pending-approval items across POs, transfers & returns — same
   * shape as the Manager dashboard's panel, so the owner can drill into the
   * specific item stuck in the queue instead of only seeing a total count. */
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

  const liveInsights = useMemo(() => {
    const live: AiInsight[] = [];
    if ((ownerLowStock ?? 0) > 0) {
      live.push({
        id: "live-reorder",
        title: "Reorder recommendation",
        detail: `${ownerLowStock} low-stock SKUs need replenishment (${scopePhrase}).`,
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
        href: "/inventory/batches?nearExpiryDays=30",
      });
    }
    if (deadStockCount != null && deadStockCount > 0) {
      live.push({
        id: "live-dead",
        title: "Dead stock candidates",
        detail: `${deadStockCount} slow movers with no sales in 90 days.`,
        tone: "info",
        href: "/reports?tab=dead",
      });
    }
    if (overduePos > 0) {
      live.push({
        id: "live-supply",
        title: "Supply delay",
        detail: `${overduePos} purchase orders are past expected delivery.`,
        tone: "danger",
        href: "/purchasing?status=overdue",
      });
    }
    if (pendingApproval > 0) {
      live.push({
        id: "live-po",
        title: "Approval bottleneck",
        detail: `${pendingApproval} POs awaiting approval may delay replenishment.`,
        tone: "info",
        href: "/purchasing?status=pending_approval",
      });
    }
    return live.slice(0, 5);
  }, [deadStockCount, nearExpiryCount, overduePos, ownerLowStock, pendingApproval, scopePhrase]);

  const allInsights = useMemo(() => {
    const filler = OWNER_AI_INSIGHTS.filter(
      (s) => !liveInsights.some((l) => l.title === s.title),
    );
    return [...liveInsights, ...filler].slice(0, 5);
  }, [liveInsights]);

  const lowN = ownerLowStock ?? 0;
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
    {
      key: "low",
      label: "Low stock",
      value: lowN,
      tone: "danger" as const,
      href: "/inventory?view=low",
    },
    {
      key: "dead",
      label: "Dead stock",
      value: deadN,
      tone: "muted" as const,
      href: "/reports?tab=dead",
    },
    {
      key: "expiry",
      label: "Near expiry ≤30d",
      value: nearExpiryCount,
      tone: "warning" as const,
      href: "/inventory/batches?nearExpiryDays=30",
    },
  ];

  const expectedPace = monthPaceExpectedPct();
  const teamStats = useMemo(() => {
    let onTrack = 0;
    let below = 0;
    let followUp = 0;
    let bestId: string | null = null;
    let bestPct = -1;
    for (const row of teamRows) {
      const status = branchTrackStatus(row.achievementPct, expectedPace);
      if (status === "on_track") onTrack += 1;
      if (status === "at_risk" || status === "below") {
        below += 1;
        followUp += 1;
      }
      if (row.achievementPct != null && row.achievementPct > bestPct) {
        bestPct = row.achievementPct;
        bestId = row.branchId;
      }
    }
    return { branchCount: teamRows.length, onTrack, below, followUp, bestId };
  }, [expectedPace, teamRows]);

  const revenueContribution = useMemo(() => {
    const total = teamRows.reduce((s, r) => s + r.monthSales, 0);
    // Color by alphabetical branch order — same stable key BranchSalesTrendPanel
    // uses — so a branch keeps one identity color across both panels.
    const alphaOrder = [...teamRows].sort((a, b) => a.name.localeCompare(b.name));
    const colorMap = new Map(alphaOrder.map((r, i) => [r.branchId, branchColor(i)]));
    return [...teamRows]
      .sort((a, b) => b.monthSales - a.monthSales)
      .map((r) => ({
        ...r,
        pct: total > 0 ? (r.monthSales / total) * 100 : 0,
        color: colorMap.get(r.branchId) ?? "var(--pc-primary)",
      }));
  }, [teamRows]);

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

      <MasonryGrid>
        <MasonryItem span={2}>
          <BusinessOverviewPanel
            fallbackTrend={salesTrend7d}
            analyticsBranchId={analyticsBranchId}
          />
        </MasonryItem>

        <MasonryItem>
          <CashFlowPanel analyticsBranchId={analyticsBranchId} />
        </MasonryItem>

        <MasonryItem span={2}>
          <BranchSalesTrendPanel />
        </MasonryItem>

        <MasonryItem>
          <TopSuppliersPanel />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel title="Pending Approvals" icon={<IconClipboardList size={15} />} compact>
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

        <MasonryItem>
        <DashboardPanel
          title="Branch Revenue Contribution"
          subtitle={`Share of ${formatYearMonth(yearMonth)} sales`}
          icon={<IconUsers size={15} />}
          compact
        >
          {revenueContribution.length === 0 ? (
            <p className={css.emptyState}>No branches to show.</p>
          ) : (
            <ul className={css.healthFlatList}>
              {revenueContribution.map((r) => (
                <li key={r.branchId}>
                  <span className={css.healthFlatRow}>
                    <span
                      className={css.healthSignalIcon}
                      style={{ background: `color-mix(in srgb, ${r.color} 16%, var(--pc-card-bg))`, color: r.color }}
                      aria-hidden
                    >
                      <IconUsers size={13} strokeWidth={1.75} />
                    </span>
                    <span className={css.healthSignalLead}>
                      <span className={css.healthSignalLabel}>{r.name}</span>
                    </span>
                    <span className={css.healthSignalTrack}>
                      <span
                        className={css.healthSignalFill}
                        style={{ width: `${Math.max(2, r.pct)}%`, background: r.color }}
                      />
                    </span>
                    <span className={css.healthSignalValue}>{r.pct.toFixed(0)}%</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
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
                    : `${attentionCount} signal${attentionCount === 1 ? "" : "s"} need attention · ${ownerScopeLabel}`}
                </span>
                <span className={css.healthTopValue}>
                  Total stock value:{" "}
                  <strong>
                    {loading ? "…" : ownerStockValue != null ? formatMoney(ownerStockValue) : "—"}
                  </strong>
                </span>
                {!loading && inventoryImprovedCount != null ? (
                  <span
                    className={`${css.healthTrend} ${
                      inventoryImprovedCount > 0 ? css.healthTrend_success : css.healthTrend_muted
                    }`}
                  >
                    <IconActivity size={12} strokeWidth={2} aria-hidden />
                    {inventoryImprovedCount > 0
                      ? `+${inventoryImprovedCount} items improved vs last ${inventoryImprovedDays} days`
                      : `No items left low/out vs last ${inventoryImprovedDays} days`}
                  </span>
                ) : null}
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

            {loading ? null : fastMoversCount != null ? (
              <Link href="/inventory/movements?category=sales" className={css.healthPositiveCallout}>
                <IconActivity size={16} strokeWidth={2.2} aria-hidden />
                <span className={css.healthPositiveText}>
                  <strong>{fastMoversCount}</strong> fast movers today — moving well, no action
                  needed.
                </span>
                <IconChevronRight
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden
                  className={css.healthPositiveChevron}
                />
              </Link>
            ) : (
              <p className={css.healthPositiveUnavailable}>
                Fast-mover count isn&apos;t available tenant-wide yet — switch to &ldquo;Current
                branch&rdquo; above to see it.
              </p>
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
                    <IconChevronRight size={13} strokeWidth={1.75} aria-hidden />
                  </Link>
                  <Link
                    href="/inventory/batches?nearExpiryDays=30"
                    className={`${css.healthActionBtn} ${css.healthActionBtn_warning}`}
                  >
                    <IconCalendar size={13} strokeWidth={1.75} aria-hidden />
                    View expiring batches
                    <IconChevronRight size={13} strokeWidth={1.75} aria-hidden />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </DashboardPanel>
        </MasonryItem>

        <MasonryItem>
          <AiInsightsCard insights={allInsights} footerHref="/reports" compact />
        </MasonryItem>

        <MasonryItem>
        <DashboardPanel
          title="Team & Branch Snapshot"
          subtitle="This month's branch performance vs target"
          icon={<IconUsers size={15} />}
          compact
          headerRight={
            <button type="button" className={css.teamSetTargetsBtn} onClick={() => setTargetsOpen(true)}>
              <IconEdit size={13} strokeWidth={1.75} aria-hidden />
              Set targets
            </button>
          }
        >
          {teamRows.length === 0 ? (
            <p className={css.emptyState}>No branches to show.</p>
          ) : (
            <div className={css.teamSnapBoard}>
              <div className={css.teamStatStrip}>
                <div className={css.teamStatCell}>
                  <div className={css.teamStatCopy}>
                    <strong className={css.teamStatValue}>{loading ? "…" : teamStats.branchCount}</strong>
                    <span className={css.teamStatLabel}>Branches</span>
                  </div>
                </div>
                <div className={css.teamStatCell}>
                  <div className={css.teamStatCopy}>
                    <strong className={`${css.teamStatValue} ${css.teamStatValue_success}`}>
                      {loading ? "…" : teamStats.onTrack}
                    </strong>
                    <span className={css.teamStatLabel}>On track</span>
                  </div>
                </div>
                <div className={css.teamStatCell}>
                  <div className={css.teamStatCopy}>
                    <strong className={`${css.teamStatValue} ${css.teamStatValue_danger}`}>
                      {loading ? "…" : teamStats.below}
                    </strong>
                    <span className={css.teamStatLabel}>Below target</span>
                  </div>
                </div>
              </div>

              <div className={css.teamTableWrap}>
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
                    {teamRows.map((row) => {
                      const pct = row.achievementPct;
                      const bar = pct != null ? Math.min(100, Math.max(0, pct)) : 0;
                      const status = branchTrackStatus(pct, expectedPace);
                      const isBest = row.branchId === teamStats.bestId;
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
              </div>

              <div className={css.teamSnapFooter}>
                <Link href="/reports" className={css.panelFooterLink}>
                  View all branches →
                </Link>
                <div className={css.teamSnapFooterRight}>
                  {teamStats.followUp > 0 ? (
                    <span className={css.teamFollowUp}>
                      <IconAlertTriangle size={13} strokeWidth={1.75} aria-hidden />
                      {teamStats.followUp} branch{teamStats.followUp === 1 ? "" : "es"} need follow-up
                      today
                    </span>
                  ) : (
                    <span className={css.teamFollowUpOk}>All branches on pace</span>
                  )}
                  <Link href="/users" className={css.teamAssignBtn}>
                    <IconUserPlus size={13} strokeWidth={1.75} aria-hidden />
                    Assign support
                  </Link>
                </div>
              </div>
            </div>
          )}
        </DashboardPanel>
        </MasonryItem>
      </MasonryGrid>

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

      <SetBranchTargetsModal
        open={targetsOpen}
        yearMonth={yearMonth}
        branches={branchPerformance}
        onClose={() => setTargetsOpen(false)}
        onSaved={() => void reload()}
      />
    </>
  );
}
