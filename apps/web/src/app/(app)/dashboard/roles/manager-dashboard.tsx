"use client";

import { useMemo } from "react";
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
  IconShoppingCart,
  IconTruck,
  IconUsers,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { OPERATIONS_ROLES, PURCHASING_ROLES } from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AlertList, type DashboardAlert } from "../components/alert-list";
import { AttentionTicker, type TickerItem } from "../components/attention-ticker";
import { BusinessOverviewPanel } from "../components/business-overview-panel";
import { DashboardPanel } from "../components/dashboard-panel";
import { HeroBand } from "../components/hero-band";
import { ProgressBar } from "../components/progress-bar";
import { QuickActionsBar } from "../components/quick-actions-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { branchTrackStatus, monthPaceExpectedPct } from "../lib/branch-status";
import { inventoryHealthScore } from "../lib/health-score";
import { MANAGER_AI_INSIGHTS, PLACEHOLDER_SERVICE_ISSUES, type AiInsight } from "../lib/placeholder-data";
import css from "../dashboard.module.css";

/** "2026-08" → "August 2026". */
function formatYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  if (!y || !m) return yearMonth;
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
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
    pendingPoApprovals,
    pendingTransferApprovals,
    pendingReturnApprovals,
    openTransfers,
    stocktakesInProgress,
    openPoList,
    transferList,
    overduePos,
    nearExpiryCount,
    topProductsToday,
    assignedBranchTargets,
    currentBranchPerf,
    branchPerfYearMonth,
    deadStockCount,
    fastMoversCount,
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
  }, [inventory, nearExpiryCount, overduePos, openTransfers, stocktakesInProgress]);

  const approvalTasks = [
    pendingPoApprovals > 0
      ? {
          key: "po",
          label: "Purchase orders awaiting approval",
          count: pendingPoApprovals,
          tone: "danger" as const,
          href: "/purchasing",
        }
      : null,
    pendingTransferApprovals > 0
      ? {
          key: "tr-appr",
          label: "Transfers awaiting approval",
          count: pendingTransferApprovals,
          tone: "warning" as const,
          href: "/transfers",
        }
      : null,
    pendingReturnApprovals > 0
      ? {
          key: "ret",
          label: "Returns awaiting approval",
          count: pendingReturnApprovals,
          tone: "warning" as const,
          href: "/returns",
        }
      : null,
    stocktakesInProgress > 0
      ? {
          key: "st",
          label: "Active stocktakes",
          count: stocktakesInProgress,
          tone: "info" as const,
          href: "/stocktakes",
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    label: string;
    count: number;
    tone: "danger" | "warning" | "info";
    href: string;
  }>;

  /** Vertical, more descriptive companion to the ticker strip — same signals, more context. */
  const operationalAlerts: DashboardAlert[] = useMemo(() => {
    const alerts: DashboardAlert[] = [];
    if ((inventory?.outOfStock ?? 0) > 0) {
      alerts.push({
        key: "oos",
        label: "Items out of stock",
        detail: "Immediate attention required",
        count: inventory!.outOfStock,
        tone: "danger",
        href: "/inventory?view=out",
        icon: <IconAlertTriangle size={13} strokeWidth={1.75} />,
      });
    }
    if ((inventory?.lowStock ?? 0) > 0) {
      alerts.push({
        key: "low",
        label: "Items low on stock",
        detail: "Reorder before they run out",
        count: inventory!.lowStock,
        tone: "warning",
        href: "/inventory?view=low",
        icon: <IconBox size={13} strokeWidth={1.75} />,
      });
    }
    if (nearExpiryCount > 0) {
      alerts.push({
        key: "exp",
        label: "Batches expiring within 30 days",
        detail: "Prioritize FEFO rotation",
        count: nearExpiryCount,
        tone: "warning",
        href: "/inventory/batches",
        icon: <IconCalendar size={13} strokeWidth={1.75} />,
      });
    }
    if (overduePos > 0) {
      alerts.push({
        key: "od",
        label: "Purchase orders overdue",
        detail: "Past expected delivery",
        count: overduePos,
        tone: "danger",
        href: "/purchasing",
        icon: <IconTruck size={13} strokeWidth={1.75} />,
      });
    }
    if (openTransfers > 0) {
      alerts.push({
        key: "xfer",
        label: "Transfers in transit",
        detail: "Awaiting receipt confirmation",
        count: openTransfers,
        tone: "info",
        href: "/transfers",
        icon: <IconTruck size={13} strokeWidth={1.75} />,
      });
    }
    if (stocktakesInProgress > 0) {
      alerts.push({
        key: "st",
        label: "Stocktakes in progress",
        detail: "Complete counts to close out",
        count: stocktakesInProgress,
        tone: "info",
        href: "/stocktakes",
        icon: <IconClipboardList size={13} strokeWidth={1.75} />,
      });
    }
    return alerts;
  }, [inventory, nearExpiryCount, overduePos, openTransfers, stocktakesInProgress]);

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
        href: "/purchasing",
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
    { key: "dead", label: "Dead stock", value: deadN, tone: "muted" as const, href: "/reports" },
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
          },
          {
            key: "approvals",
            label: "Pending Approvals",
            value: pendingApprovalsTotal,
            meta: "POs, transfers & returns",
          },
        ]}
      />

      <AttentionTicker items={tickerItems} loading={loading} allClearText="No operational alerts — branch looks healthy" />

      <div className={css.mainSplit}>
        <BusinessOverviewPanel
          title="Branch Performance Overview"
          fallbackTrend={salesTrend7d}
          analyticsBranchId={branchId}
        />

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
                  <strong>{fastMoversCount ?? 0}</strong> fast movers this week — moving well, no action
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
      </div>

      <div className={css.grid3}>
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
                    <th>Today&apos;s Sales</th>
                    <th>Target</th>
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
                        <td className={css.teamNum}>{formatMoney(row.todaySales)}</td>
                        <td className={`${css.muted} ${css.teamNum}`}>
                          {row.targetAmount != null ? formatMoney(row.targetAmount) : "—"}
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

        <DashboardPanel title="Approvals & Tasks" footerHref="/purchasing" footerLabel="Open purchasing →">
          <AlertList showAction emptyText="No pending approvals or active stocktakes." alerts={approvalTasks} />
        </DashboardPanel>
      </div>

      <div className={css.grid3}>
        <DashboardPanel title="Transfer & PO Pipeline" footerHref="/purchasing" footerLabel="Open pipeline →">
          {openPoList.length === 0 && transferList.length === 0 ? (
            <p className={css.emptyState}>No open pipeline items.</p>
          ) : (
            <ul className={css.pipelineList}>
              {openPoList.slice(0, 3).map((po) => (
                <li key={po.id}>
                  <Link href={`/purchasing?po=${po.id}`}>
                    <span className={`${css.pipelineIcon} ${css.pipelineIcon_po}`} aria-hidden>
                      <IconShoppingCart size={14} strokeWidth={1.75} />
                    </span>
                    <span className={css.pipelineRowBody}>
                      <strong>{po.poNumber}</strong>
                      <span className={css.muted}>{po.supplier.name}</span>
                    </span>
                    <StatusBadge status={po.status} />
                  </Link>
                </li>
              ))}
              {transferList.slice(0, 2).map((t) => (
                <li key={t.id}>
                  <Link href={`/transfers?transfer=${t.id}`}>
                    <span className={`${css.pipelineIcon} ${css.pipelineIcon_transfer}`} aria-hidden>
                      <IconTruck size={14} strokeWidth={1.75} />
                    </span>
                    <span className={css.pipelineRowBody}>
                      <strong>{t.transferNumber}</strong>
                      <span className={css.muted}>
                        {[t.fromBranch?.name, t.toBranch?.name].filter(Boolean).join(" → ") || "Transfer"}
                      </span>
                    </span>
                    <StatusBadge status={t.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>

        <DashboardPanel title="Top Products Today" footerHref="/reports" footerLabel="Open reports →">
          {topProductsToday.length === 0 ? (
            <p className={css.emptyState}>No sales recorded yet today.</p>
          ) : (
            <ul className={css.topProductsList}>
              {topProductsToday.slice(0, 5).map((p, i) => (
                <li key={p.sku} className={css.topProductRow}>
                  <span className={`${css.topProductRank}${i === 0 ? ` ${css.topProductRank_lead}` : ""}`}>
                    {i + 1}
                  </span>
                  <span className={css.topProductBody}>
                    <strong>{p.name}</strong>
                    <span>{p.sku}</span>
                  </span>
                  <span className={css.topProductQty}>{p.qty} sold</span>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>

        <DashboardPanel title="Customer Service Issues" headerRight={<span className={css.placeholderBadge}>Sample</span>}>
          <p className={css.placeholderNote}>Ops task board coming soon — sample priorities shown.</p>
          <ul className={css.issueList}>
            {PLACEHOLDER_SERVICE_ISSUES.map((issue) => (
              <li key={issue.id}>
                <span>{issue.label}</span>
                <span className={`${css.priorityPill} ${css[`priority_${issue.priority}`]}`}>
                  {issue.priority}
                </span>
              </li>
            ))}
          </ul>
        </DashboardPanel>
      </div>

      <div className={css.grid2}>
        <AiInsightsCard insights={allInsights} footerHref="/analytics" />

        <DashboardPanel title="Operational Alerts" icon={<IconAlertTriangle size={15} />}>
          <AlertList
            showAction
            emptyText="No operational alerts — branch looks healthy."
            alerts={operationalAlerts}
          />
        </DashboardPanel>
      </div>

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
