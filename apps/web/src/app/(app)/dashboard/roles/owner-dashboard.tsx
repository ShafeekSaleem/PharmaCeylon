"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconAlertTriangle,
  IconArchive,
  IconBanknote,
  IconBell,
  IconBox,
  IconCalendar,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClipboardList,
  IconCreditCard,
  IconPackage,
  IconShield,
  IconShoppingCart,
  IconTruck,
  IconUserPlus,
  IconUsers,
} from "@/components/icons";
import { StatCard } from "@/components/ui";
import { formatMoney } from "@/app/(app)/inventory/utils";
import {
  OPERATIONS_ROLES,
  PURCHASING_ROLES,
} from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AlertList } from "../components/alert-list";
import { BusinessOverviewPanel } from "../components/business-overview-panel";
import { CashFlowPanel } from "../components/cash-flow-panel";
import { DashboardPanel } from "../components/dashboard-panel";
import { ProgressBar } from "../components/progress-bar";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SetBranchTargetsModal } from "../components/set-branch-targets-modal";
import type { DashboardData } from "../hooks/use-dashboard-data";
import {
  OWNER_AI_INSIGHTS,
  type AiInsight,
} from "../lib/placeholder-data";
import css from "../dashboard.module.css";

type HealthTone = "success" | "warning" | "danger";
type BranchTrackStatus = "on_track" | "at_risk" | "below" | "none";

function inventoryHealthScore(input: {
  low: number;
  dead: number;
  nearExpiry: number;
  fast: number;
}): { score: number; tone: HealthTone; label: string } {
  const risk = input.low * 3 + input.dead * 1 + input.nearExpiry * 2;
  const boost = Math.min(12, input.fast * 0.15);
  const score = Math.round(
    Math.max(0, Math.min(100, 100 - Math.min(72, risk * 0.75) + boost)),
  );
  if (score >= 70) return { score, tone: "success", label: "Good" };
  if (score >= 45) return { score, tone: "warning", label: "Fair" };
  return { score, tone: "danger", label: "Critical" };
}

function monthPaceExpectedPct(d = new Date()): number {
  const day = d.getDate();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return (day / daysInMonth) * 100;
}

function branchTrackStatus(
  achievementPct: number | null | undefined,
  expectedPct = monthPaceExpectedPct(),
): BranchTrackStatus {
  if (achievementPct == null) return "none";
  if (achievementPct >= expectedPct * 0.95) return "on_track";
  if (achievementPct >= expectedPct * 0.55) return "at_risk";
  return "below";
}

type Props = { data: DashboardData };

export function OwnerDashboard({ data }: Props) {
  const {
    loading,
    ownerLowStock,
    ownerStockValue,
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
    ownerSalesTrendLabel,
    ownerSalesTrendPositive,
    ownerTodayGrossProfit,
    ownerGrossProfitTrendLabel,
    ownerGrossProfitTrendPositive,
    hasMarginData,
    marginPct,
    openPos,
    openPoValue,
    reload,
  } = data;

  const [targetsOpen, setTargetsOpen] = useState(false);
  const yearMonth =
    branchPerfYearMonth ??
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const teamRows = scopedBranchPerformance ?? branchPerformance;
  const scopePhrase = ownerScopeLabel.toLowerCase();

  const alerts = [
    controlledAttentionCount > 0
      ? {
          key: "ctrl",
          label: "Controlled drugs attention",
          detail: `${ownerScopeLabel} · low or near-expiry controlled stock`,
          count: controlledAttentionCount,
          tone: "danger" as const,
          href: "/inventory?controlled=controlled",
          icon: <IconShield size={13} strokeWidth={1.75} />,
        }
      : null,
    (ownerLowStock ?? 0) > 0
      ? {
          key: "low",
          label: "Low stock items",
          detail: `${ownerScopeLabel} · below reorder level`,
          count: ownerLowStock!,
          tone: "warning" as const,
          href: "/inventory?view=low",
          icon: <IconAlertTriangle size={13} strokeWidth={1.75} />,
        }
      : null,
    nearExpiryCount > 0
      ? {
          key: "expiry",
          label: "Expiring batches",
          detail: `${ownerScopeLabel} · within 30 days`,
          count: nearExpiryCount,
          tone: "warning" as const,
          href: "/inventory/batches?nearExpiryDays=30",
          icon: <IconCalendar size={13} strokeWidth={1.75} />,
        }
      : null,
    openTransfers > 0
      ? {
          key: "xfer",
          label: "Open transfers",
          detail: "In progress across branches",
          count: openTransfers,
          tone: "info" as const,
          href: "/transfers",
          icon: <IconTruck size={13} strokeWidth={1.75} />,
        }
      : null,
    overduePos > 0
      ? {
          key: "overdue",
          label: "Overdue deliveries",
          detail: `${ownerScopeLabel} · past expected date`,
          count: overduePos,
          tone: "danger" as const,
          href: "/purchasing",
          icon: <IconClipboardList size={13} strokeWidth={1.75} />,
        }
      : null,
    pendingApproval > 0
      ? {
          key: "po",
          label: "POs pending approval",
          detail: `${ownerScopeLabel} · awaiting review`,
          count: pendingApproval,
          tone: "info" as const,
          href: "/purchasing",
          icon: <IconBell size={13} strokeWidth={1.75} />,
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    label: string;
    detail: string;
    count: number;
    tone: "danger" | "warning" | "info";
    href: string;
    icon: ReactNode;
  }>;

  const { insights, insightsAreSample } = useMemo(() => {
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
        href: "/reports",
      });
    }
    if (overduePos > 0) {
      live.push({
        id: "live-supply",
        title: "Supply delay",
        detail: `${overduePos} purchase orders are past expected delivery.`,
        tone: "danger",
        href: "/purchasing",
      });
    }
    if (pendingApproval > 0) {
      live.push({
        id: "live-po",
        title: "Approval bottleneck",
        detail: `${pendingApproval} POs awaiting approval may delay replenishment.`,
        tone: "info",
        href: "/purchasing",
      });
    }
    if (live.length >= 3) {
      return { insights: live.slice(0, 5), insightsAreSample: false };
    }
    const filler = OWNER_AI_INSIGHTS.filter(
      (s) => !live.some((l) => l.title === s.title),
    );
    return {
      insights: [...live, ...filler].slice(0, 5),
      insightsAreSample: live.length === 0,
    };
  }, [
    deadStockCount,
    nearExpiryCount,
    overduePos,
    ownerLowStock,
    pendingApproval,
    scopePhrase,
  ]);

  const lowN = ownerLowStock ?? 0;
  const deadN = deadStockCount ?? 0;
  const fastN = fastMoversCount ?? 0;
  const health = useMemo(
    () =>
      inventoryHealthScore({
        low: lowN,
        dead: deadN,
        nearExpiry: nearExpiryCount,
        fast: fastN,
      }),
    [deadN, fastN, lowN, nearExpiryCount],
  );
  const attentionCount = lowN + deadN + nearExpiryCount;
  const atRiskCount = nearExpiryCount;
  const healthBarMax = Math.max(lowN, deadN, nearExpiryCount, fastN, 1);
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
      icon: <IconBox size={14} strokeWidth={1.75} />,
    },
    {
      key: "dead",
      label: "Dead stock",
      value: deadN,
      tone: "muted" as const,
      href: "/reports",
      icon: <IconArchive size={14} strokeWidth={1.75} />,
    },
    {
      key: "expiry",
      label: "Near expiry ≤30d",
      value: nearExpiryCount,
      tone: "warning" as const,
      href: "/inventory/batches?nearExpiryDays=30",
      icon: <IconCalendar size={14} strokeWidth={1.75} />,
    },
    {
      key: "fast",
      label: "Fast movers",
      value: fastN,
      tone: "success" as const,
      href: "/reports",
      icon: <IconActivity size={14} strokeWidth={1.75} />,
    },
  ];
  const atRiskBadge =
    atRiskCount > 0
      ? { label: "Needs attention", tone: "danger" as const }
      : { label: "Clear", tone: "success" as const };

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
      // Summary “Below target” = not on pace (at risk + below).
      if (status === "at_risk" || status === "below") {
        below += 1;
        followUp += 1;
      }
      if (row.achievementPct != null && row.achievementPct > bestPct) {
        bestPct = row.achievementPct;
        bestId = row.branchId;
      }
    }
    return {
      branchCount: teamRows.length,
      onTrack,
      below,
      followUp,
      bestId,
    };
  }, [expectedPace, teamRows]);

  return (
    <>
      <div className={`${css.kpiRow} ${css.ownerDense}`}>
        <StatCard
          size="sm"
          title="Today's Sales"
          value={loading ? "…" : formatMoney(ownerTodaySalesTotal)}
          subtitle={`${ownerScopeLabel} · vs yesterday`}
          icon={<IconShoppingCart size={15} strokeWidth={1.75} />}
          iconTone="primary"
          trend={
            ownerSalesTrendLabel
              ? {
                  value: ownerSalesTrendLabel,
                  direction: ownerSalesTrendPositive ? "up" : "down",
                  tone: ownerSalesTrendPositive ? "positive" : "danger",
                }
              : undefined
          }
          menuItems={[
            { label: "View reports", href: "/reports" },
            { label: "Open analytics", href: "/analytics" },
          ]}
        />
        <StatCard
          size="sm"
          title="Gross Profit (Today)"
          value={
            loading ? "…" : hasMarginData ? formatMoney(ownerTodayGrossProfit) : "—"
          }
          subtitle={
            hasMarginData && marginPct != null
              ? `${ownerScopeLabel} · margin ${marginPct.toFixed(1)}% · vs yesterday`
              : `${ownerScopeLabel} · from margin report`
          }
          icon={<IconActivity size={15} strokeWidth={1.75} />}
          iconTone="success"
          trend={
            hasMarginData && ownerGrossProfitTrendLabel
              ? {
                  value: ownerGrossProfitTrendLabel,
                  direction: ownerGrossProfitTrendPositive ? "up" : "down",
                  tone: ownerGrossProfitTrendPositive ? "positive" : "danger",
                }
              : undefined
          }
          menuItems={[
            { label: "View analytics", href: "/analytics" },
            { label: "View reports", href: "/reports" },
          ]}
        />
        <StatCard
          size="sm"
          title="Low Stock Items"
          value={loading ? "…" : (ownerLowStock ?? "—")}
          subtitle={`${ownerScopeLabel} · reorder soon`}
          icon={<IconAlertTriangle size={15} strokeWidth={1.75} />}
          iconTone="warning"
          menuItems={[
            { label: "View low stock", href: "/inventory?view=low" },
            { label: "Open inventory", href: "/inventory" },
          ]}
        />
        <StatCard
          size="sm"
          title="Pending POs"
          value={loading ? "…" : openPos}
          subtitle={`${ownerScopeLabel} · ${formatMoney(openPoValue)}`}
          icon={<IconClipboardList size={15} strokeWidth={1.75} />}
          iconTone="info"
          menuItems={[
            { label: "View POs", href: "/purchasing" },
            { label: "Create PO", href: "/purchasing?action=create-po" },
          ]}
        />
        <StatCard
          size="sm"
          title="Near Expiry"
          value={loading ? "…" : nearExpiryCount}
          subtitle={`${ownerScopeLabel} · within 30 days`}
          icon={<IconCalendar size={15} strokeWidth={1.75} />}
          iconTone="warning"
          menuItems={[
            { label: "View batches", href: "/inventory/batches?nearExpiryDays=30" },
            { label: "Open inventory", href: "/inventory" },
          ]}
        />
        <StatCard
          size="sm"
          title="Outstanding Receivables"
          value={
            loading
              ? "…"
              : financial
                ? formatMoney(financial.receivablesOutstanding)
                : "—"
          }
          subtitle={
            financial
              ? `${ownerScopeLabel} · ${financial.receivablesCustomerCount} customers`
              : `${ownerScopeLabel} · credit sales`
          }
          icon={<IconCreditCard size={15} strokeWidth={1.75} />}
          iconTone="info"
          menuItems={[{ label: "View reports", href: "/reports" }]}
        />
      </div>

      <div className={`${css.mainSplitOwner} ${css.ownerDense}`}>
        <BusinessOverviewPanel
          fallbackTrend={salesTrend7d}
          analyticsBranchId={analyticsBranchId}
        />
        <CashFlowPanel
          financial={financial}
          analyticsBranchId={analyticsBranchId}
        />
        <DashboardPanel
          title="Operational Alerts"
          icon={<IconBell size={14} />}
          compact
          className={css.splitPanel}
          footerHref="/inventory?view=low"
          footerLabel="View all alerts →"
        >
          <AlertList
            alerts={alerts}
            emptyText="No active alerts — everything looks healthy."
          />
        </DashboardPanel>
      </div>

      <div className={`${css.ownerLower3} ${css.ownerDense} ${css.ownerEqualRow}`}>
        <DashboardPanel
          title="Inventory Health"
          icon={<IconPackage size={14} />}
          compact
          className={css.healthPanel}
        >
          <div className={css.healthBoard}>
            <div className={css.healthSummary}>
              <div className={css.healthValueBlock}>
                <div className={css.healthValueHead}>
                  <span className={css.healthValueIcon} aria-hidden>
                    <IconBanknote size={15} strokeWidth={1.75} />
                  </span>
                  <div className={css.healthValueCopy}>
                    <span className={css.healthValueLabel}>Total stock value</span>
                    <strong className={css.healthValueAmount}>
                      {loading
                        ? "…"
                        : ownerStockValue != null
                          ? formatMoney(ownerStockValue)
                          : "—"}
                    </strong>
                    <span className={css.healthValueMeta}>
                      {ownerScopeLabel}
                      {loading
                        ? ""
                        : ` · ${attentionCount} attention signal${attentionCount === 1 ? "" : "s"}`}
                    </span>
                    {!loading && inventoryImprovedCount != null ? (
                      <span
                        className={`${css.healthTrend} ${
                          inventoryImprovedCount > 0
                            ? css.healthTrend_success
                            : css.healthTrend_muted
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
              </div>

              <div className={`${css.healthStatCard} ${css.healthStat_success}`}>
                <span className={`${css.healthStatIcon} ${css.healthStatIcon_success}`} aria-hidden>
                  <IconActivity size={13} strokeWidth={1.75} />
                </span>
                <span className={css.healthStatLabel}>Health score</span>
                <strong className={`${css.healthStatValue} ${css.healthStatValue_success}`}>
                  {loading ? "…" : `${health.score}%`}
                </strong>
                <span className={`${css.healthPill} ${css[`healthPill_${health.tone}`]}`}>
                  {loading ? "…" : health.label}
                </span>
              </div>

              <div className={`${css.healthStatCard} ${css.healthStat_danger}`}>
                <span className={`${css.healthStatIcon} ${css.healthStatIcon_danger}`} aria-hidden>
                  <IconShield size={13} strokeWidth={1.75} />
                </span>
                <span className={css.healthStatLabel}>At risk</span>
                <strong className={`${css.healthStatValue} ${css.healthStatValue_danger}`}>
                  {loading ? "…" : atRiskCount}
                </strong>
                <span className={`${css.healthPill} ${css[`healthPill_${atRiskBadge.tone}`]}`}>
                  {loading ? "…" : atRiskBadge.label}
                </span>
              </div>
            </div>

            <ul className={css.healthSignalList}>
              {healthSignals.map((signal) => {
                const pct =
                  loading || signal.value === 0
                    ? 0
                    : Math.max(
                        8,
                        Math.round((signal.value / healthBarMax) * 100),
                      );
                return (
                  <li key={signal.key}>
                    <Link href={signal.href} className={css.healthSignalRow}>
                      <span
                        className={`${css.healthSignalIcon} ${css[`healthSignalIcon_${signal.tone}`]}`}
                        aria-hidden
                      >
                        {signal.icon}
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
                      <span
                        className={`${css.healthSignalValue} ${css[`healthSignalValue_${signal.tone}`]}`}
                      >
                        {loading ? "…" : signal.value}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className={css.healthActions}>
              <div className={css.healthActionsHead}>
                <span className={css.healthPriorityBadge} aria-hidden>
                  ★
                </span>
                <span>Priority actions</span>
              </div>
              <div className={css.healthActionsRow}>
                <Link
                  href="/inventory?view=low"
                  className={`${css.healthActionBtn} ${css.healthActionBtn_primary}`}
                >
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
                <Link href="/inventory" className={css.healthReportLink}>
                  View inventory report →
                </Link>
              </div>
            </div>
          </div>
        </DashboardPanel>

        <AiInsightsCard
          insights={insights}
          footerHref="/analytics"
          compact
          showSampleBadge={insightsAreSample}
        />

        <DashboardPanel
          title="Team & Branch Snapshot"
          subtitle="Daily branch performance vs target"
          icon={<IconUsers size={14} />}
          compact
          className={css.teamSnapPanel}
          headerRight={
            <button
              type="button"
              className={css.teamSetTargetsBtn}
              onClick={() => setTargetsOpen(true)}
            >
              <IconActivity size={13} strokeWidth={1.75} aria-hidden />
              Set targets
            </button>
          }
        >
          {teamRows.length === 0 ? (
            <p className={css.emptyState}>
              No branch targets yet. Set monthly sales targets to track
              achievement.
            </p>
          ) : (
            <div className={css.teamSnapBoard}>
              <div className={css.teamStatStrip}>
                <div className={css.teamStatCell}>
                  <span className={`${css.teamStatIcon} ${css.teamStatIcon_primary}`} aria-hidden>
                    <IconUsers size={13} strokeWidth={1.75} />
                  </span>
                  <div className={css.teamStatCopy}>
                    <strong className={css.teamStatValue}>
                      {loading ? "…" : teamStats.branchCount}
                    </strong>
                    <span className={css.teamStatLabel}>Branches</span>
                  </div>
                </div>
                <div className={css.teamStatCell}>
                  <span className={`${css.teamStatIcon} ${css.teamStatIcon_success}`} aria-hidden>
                    <IconChevronUp size={13} strokeWidth={2} />
                  </span>
                  <div className={css.teamStatCopy}>
                    <strong className={`${css.teamStatValue} ${css.teamStatValue_success}`}>
                      {loading ? "…" : teamStats.onTrack}
                    </strong>
                    <span className={css.teamStatLabel}>On track</span>
                  </div>
                </div>
                <div className={css.teamStatCell}>
                  <span className={`${css.teamStatIcon} ${css.teamStatIcon_danger}`} aria-hidden>
                    <IconChevronDown size={13} strokeWidth={2} />
                  </span>
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
                      <th>Today&apos;s Sales</th>
                      <th>Target</th>
                      <th>Achievement</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamRows.map((row) => {
                      const pct = row.achievementPct;
                      const bar =
                        pct != null ? Math.min(100, Math.max(0, pct)) : 0;
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
                        <tr
                          key={row.branchId}
                          className={isBest ? css.teamRowBest : undefined}
                        >
                          <td>
                            <span className={css.teamBranchCell}>
                              <span className={css.teamBranchDot} aria-hidden />
                              <span className={css.branchName}>{row.name}</span>
                              {isBest ? (
                                <span className={css.teamBestBadge}>Best</span>
                              ) : null}
                            </span>
                          </td>
                          <td className={css.teamNum}>
                            {formatMoney(row.todaySales)}
                          </td>
                          <td className={`${css.muted} ${css.teamNum}`}>
                            {row.targetAmount != null
                              ? formatMoney(row.targetAmount)
                              : "—"}
                          </td>
                          <td>
                            {pct != null ? (
                              <ProgressBar
                                value={bar}
                                label={`${pct.toFixed(0)}%`}
                                tone={tone}
                              />
                            ) : (
                              <span className={css.muted}>—</span>
                            )}
                          </td>
                          <td>
                            {status === "none" ? (
                              <span className={css.muted}>—</span>
                            ) : (
                              <span
                                className={`${css.teamStatus} ${css[`teamStatus_${status}`]}`}
                              >
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
                      {teamStats.followUp} branch
                      {teamStats.followUp === 1 ? "" : "es"} need follow-up today
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
      </div>

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
