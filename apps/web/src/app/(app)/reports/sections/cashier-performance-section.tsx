"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconCheckCircle,
  IconCloudSun,
  IconDollarSign,
  IconMoon,
  IconShield,
  IconShoppingBag,
  IconSun,
  IconTag,
  IconTrophy,
  IconUsers,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { fetchCashierAggregateComparison } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { RankingTableCard } from "../components/ranking-table-card";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { ShiftPerformanceCard, type ShiftDatum, type ShiftIconTone, type ShiftMetric } from "../components/shift-performance-card";
import type { CashierRow, ExportPayload, OnExportData, Scope, ShiftRow } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

type EnrichedCashier = CashierRow & { revenueN: number; avgBasketN: number; discountRateN: number };

const LEADERBOARD_PREVIEW_SIZE = 5;
const LEADERBOARD_PAGE_SIZE = 10;

const SHIFT_ICONS: Record<string, ReactNode> = {
  morning: <IconSun size={18} />,
  afternoon: <IconCloudSun size={18} />,
  evening: <IconMoon size={18} />,
};

const SHIFT_ICON_TONES: Record<string, ShiftIconTone> = {
  morning: "amber",
  afternoon: "green",
  evening: "indigo",
};

function discountTone(pct: number): "success" | "primary" | "warning" {
  if (pct >= 10) return "warning";
  if (pct >= 4) return "primary";
  return "success";
}

export function CashierPerformanceSection({ scope, isOwner, days, onExportData }: Props) {
  const [cashiers, setCashiers] = useState<EnrichedCashier[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [previousRevenue, setPreviousRevenue] = useState(0);
  const [previousTransactions, setPreviousTransactions] = useState(0);
  const [previousActiveCashierCount, setPreviousActiveCashierCount] = useState(0);
  const [leaderboardExpanded, setLeaderboardExpanded] = useState(false);
  const [shiftMetric, setShiftMetric] = useState<ShiftMetric>("revenue");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCashierAggregateComparison(days, scope, isOwner)
      .then((res) => {
        if (cancelled) return;
        setCashiers(res.current.cashiers.map((c) => ({ ...c, revenueN: Number(c.revenue), avgBasketN: Number(c.avgBasket), discountRateN: Number(c.discountRatePct) })));
        setShifts(res.current.shifts);
        setPreviousRevenue(res.previousRevenue);
        setPreviousTransactions(res.previousTransactions);
        setPreviousActiveCashierCount(res.previousActiveCashierCount);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load cashier performance");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const sortedCashiers = useMemo(() => [...cashiers].sort((a, b) => b.revenueN - a.revenueN), [cashiers]);

  const totalRevenue = cashiers.reduce((s, c) => s + c.revenueN, 0);
  const totalTxns = cashiers.reduce((s, c) => s + c.transactions, 0);
  const revenuePerCashier = cashiers.length > 0 ? totalRevenue / cashiers.length : 0;
  const txnsPerCashier = cashiers.length > 0 ? totalTxns / cashiers.length : 0;
  const avgBasketOverall = totalTxns > 0 ? totalRevenue / totalTxns : 0;

  const avgDiscountRate = cashiers.length > 0 ? cashiers.reduce((s, c) => s + c.discountRateN, 0) / cashiers.length : 0;
  const avgCorrectionRate = cashiers.length > 0 ? cashiers.reduce((s, c) => s + (c.transactions > 0 ? c.corrections / c.transactions : 0), 0) / cashiers.length : 0;

  const topPerformer = sortedCashiers[0] ?? null;
  const needsSupport = [...cashiers].filter((c) => c.transactions > 0).sort((a, b) => a.revenueN - b.revenueN)[0] ?? null;
  const highestBasketCashier = cashiers.length > 0 ? [...cashiers].filter((c) => c.transactions > 0).sort((a, b) => b.avgBasketN - a.avgBasketN)[0] ?? null : null;
  const unusualDiscount = cashiers.filter((c) => c.discountRateN > avgDiscountRate * 1.5 && c.discountRateN > 5);
  const highVoidRate = cashiers.filter((c) => c.transactions > 0 && c.corrections / c.transactions > Math.max(0.05, avgCorrectionRate * 1.5));

  function scrollToLeaderboard() {
    document.getElementById("cashier-leaderboard")?.scrollIntoView({ behavior: "smooth" });
  }
  function scrollToShiftPerformance() {
    document.getElementById("shift-performance")?.scrollIntoView({ behavior: "smooth" });
  }

  const coachingItems: ActionPanelItem[] = [
    ...(topPerformer
      ? [{
          key: "top",
          icon: <IconCheckCircle size={16} />,
          tone: "primary" as const,
          title: "Top Performer",
          description: `${topPerformer.name} — ${formatMoney(topPerformer.revenueN)} revenue`,
          count: topPerformer.transactions,
          countLabel: "sales",
          onClick: scrollToLeaderboard,
          examples: [{ label: topPerformer.name, badge: formatMoney(topPerformer.revenueN), tone: "positive" as const }],
        }]
      : []),
    ...(highestBasketCashier
      ? [{
          key: "highest-basket",
          icon: <IconShoppingBag size={16} />,
          tone: "warning" as const,
          title: "Highest Basket",
          description: `${highestBasketCashier.name} — ${formatMoney(highestBasketCashier.avgBasketN)} average basket`,
          count: highestBasketCashier.transactions,
          countLabel: "sales",
          onClick: scrollToLeaderboard,
          examples: [{ label: highestBasketCashier.name, badge: formatMoney(highestBasketCashier.avgBasketN), tone: "positive" as const }],
        }]
      : []),
    ...(needsSupport && cashiers.length > 1
      ? [{
          key: "support",
          icon: <IconUsers size={16} />,
          tone: "purple" as const,
          title: "Needs Support",
          description: `${needsSupport.name} — lowest revenue this period`,
          count: needsSupport.transactions,
          countLabel: "sales",
          onClick: scrollToLeaderboard,
          examples: [{ label: needsSupport.name, badge: formatMoney(needsSupport.revenueN), tone: "neutral" as const }],
        }]
      : []),
    ...(unusualDiscount.length > 0
      ? [{
          key: "discount",
          icon: <IconTag size={16} />,
          tone: "warning" as const,
          title: "Unusual Discount Usage",
          description: "Discount rate well above the team average.",
          count: unusualDiscount.length,
          countLabel: unusualDiscount.length === 1 ? "cashier" : "cashiers",
          onClick: scrollToLeaderboard,
          examples: unusualDiscount.slice(0, 3).map((c) => ({ label: c.name, badge: `${c.discountRateN.toFixed(1)}%`, tone: "neutral" as const })),
        }]
      : []),
    ...(highVoidRate.length > 0
      ? [{
          key: "voids",
          icon: <IconShield size={16} />,
          tone: "muted" as const,
          title: "Accuracy Watch",
          description: "High voids/corrections relative to the team average.",
          count: highVoidRate.length,
          countLabel: highVoidRate.length === 1 ? "cashier" : "cashiers",
          onClick: scrollToLeaderboard,
          examples: highVoidRate.slice(0, 3).map((c) => ({ label: c.name, badge: `${((c.corrections / c.transactions) * 100).toFixed(1)}%`, tone: "negative" as const })),
        }]
      : []),
  ];

  useEffect(() => {
    if (cashiers.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `cashier-performance-${days}d.csv`,
      headers: ["Cashier", "Revenue", "Transactions", "Avg Basket", "Discount Rate %", "Voids/Corrections"],
      rows: cashiers.map((c) => [c.name, c.revenueN, c.transactions, c.avgBasketN.toFixed(2), c.discountRateN.toFixed(1), c.corrections]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [cashiers, days, onExportData]);

  const shiftTotal = shifts.reduce((s, r) => s + Number(r.revenue), 0);
  const shiftData: ShiftDatum[] = useMemo(() => {
    const enriched = shifts.map((s) => ({
      key: s.key,
      label: s.label,
      revenueN: Number(s.revenue),
      avgBasketN: Number(s.avgBasket),
      transactions: s.transactions,
      revenuePerCashier: s.activeCashiers > 0 ? Number(s.revenue) / s.activeCashiers : 0,
    }));
    const bestKey = [...enriched].sort((a, b) => b.revenueN - a.revenueN)[0]?.key ?? null;
    return enriched.map((s) => ({
      key: s.key,
      label: s.label,
      icon: SHIFT_ICONS[s.key] ?? <IconSun size={18} />,
      iconTone: SHIFT_ICON_TONES[s.key] ?? "amber",
      sharePct: shiftTotal > 0 ? (s.revenueN / shiftTotal) * 100 : 0,
      revenue: s.revenueN,
      transactions: s.transactions,
      avgBasket: s.avgBasketN,
      revenuePerCashier: s.revenuePerCashier,
      isBest: s.key === bestKey,
    }));
  }, [shifts, shiftTotal]);

  const bestShift = shiftData.find((s) => s.isBest) ?? null;
  const highestBasketShift = shiftData.length > 0 ? [...shiftData].sort((a, b) => b.avgBasket - a.avgBasket)[0]! : null;
  const productiveShifts = shiftData.filter((s) => s.revenuePerCashier > 0);
  const bestProductivityShift = productiveShifts.length > 0 ? [...productiveShifts].sort((a, b) => b.revenuePerCashier - a.revenuePerCashier)[0]! : null;
  const lowestProductivityShift = productiveShifts.length > 1 ? [...productiveShifts].sort((a, b) => a.revenuePerCashier - b.revenuePerCashier)[0]! : null;

  const shiftInsightItems: ActionPanelItem[] = [
    ...(bestShift
      ? [{
          key: "best-shift",
          icon: <IconTrophy size={16} />,
          tone: "primary" as const,
          title: `Best Shift: ${bestShift.label}`,
          description: `${bestShift.sharePct.toFixed(0)}% of daily revenue.`,
          count: 1,
          countLabel: "shift",
          onClick: scrollToShiftPerformance,
          examples: [{ label: bestShift.label, badge: formatMoney(bestShift.revenue), tone: "positive" as const }],
        }]
      : []),
    ...(highestBasketShift
      ? [{
          key: "highest-basket-shift",
          icon: <IconShoppingBag size={16} />,
          tone: "warning" as const,
          title: `Highest Basket: ${highestBasketShift.label}`,
          description: `${formatMoney(highestBasketShift.avgBasket)} average basket.`,
          count: 1,
          countLabel: "shift",
          onClick: scrollToShiftPerformance,
          examples: [{ label: highestBasketShift.label, badge: formatMoney(highestBasketShift.avgBasket), tone: "positive" as const }],
        }]
      : []),
    ...(bestProductivityShift
      ? [{
          key: "best-productivity",
          icon: <IconChevronUp size={16} />,
          tone: "primary" as const,
          title: `Best Productivity: ${bestProductivityShift.label}`,
          description: "Highest revenue per cashier.",
          count: 1,
          countLabel: "shift",
          onClick: scrollToShiftPerformance,
          examples: [{ label: bestProductivityShift.label, badge: formatMoney(bestProductivityShift.revenuePerCashier), tone: "positive" as const }],
        }]
      : []),
    ...(lowestProductivityShift
      ? [{
          key: "lowest-productivity",
          icon: <IconChevronDown size={16} />,
          tone: "purple" as const,
          title: `Lowest Productivity: ${lowestProductivityShift.label}`,
          description: "Lowest revenue per cashier.",
          count: 1,
          countLabel: "shift",
          onClick: scrollToShiftPerformance,
          examples: [{ label: lowestProductivityShift.label, badge: formatMoney(lowestProductivityShift.revenuePerCashier), tone: "neutral" as const }],
        }]
      : []),
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  const visibleCashiers = leaderboardExpanded ? sortedCashiers : sortedCashiers.slice(0, LEADERBOARD_PREVIEW_SIZE);

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard
          size="sm" showMenu={false}
          title="Active Cashiers"
          value={loading ? "…" : cashiers.length}
          subtitle={`Last ${days} days`}
          icon={<IconUsers size={16} />}
          trend={!loading && previousActiveCashierCount > 0 ? { value: formatPctTrend(pctChange(cashiers.length, previousActiveCashierCount)), direction: cashiers.length >= previousActiveCashierCount ? "up" : "down", tone: cashiers.length >= previousActiveCashierCount ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Revenue per Cashier"
          value={loading ? "…" : formatMoney(revenuePerCashier)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          iconTone="success"
          trend={!loading && previousRevenue > 0 && previousActiveCashierCount > 0 ? { value: formatPctTrend(pctChange(revenuePerCashier, previousRevenue / previousActiveCashierCount)), direction: revenuePerCashier >= previousRevenue / previousActiveCashierCount ? "up" : "down", tone: revenuePerCashier >= previousRevenue / previousActiveCashierCount ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Transactions per Cashier"
          value={loading ? "…" : txnsPerCashier.toFixed(1)}
          subtitle="Average"
          icon={<IconUsers size={16} />}
          iconTone="info"
          trend={!loading && previousTransactions > 0 && previousActiveCashierCount > 0 ? { value: formatPctTrend(pctChange(txnsPerCashier, previousTransactions / previousActiveCashierCount)), direction: txnsPerCashier >= previousTransactions / previousActiveCashierCount ? "up" : "down", tone: txnsPerCashier >= previousTransactions / previousActiveCashierCount ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Avg. Basket per Cashier"
          value={loading ? "…" : formatMoney(avgBasketOverall)}
          subtitle="Blended average"
          icon={<IconDollarSign size={16} />}
          iconTone="warning"
          trend={!loading && previousRevenue > 0 && previousTransactions > 0 ? { value: formatPctTrend(pctChange(avgBasketOverall, previousRevenue / previousTransactions)), direction: avgBasketOverall >= previousRevenue / previousTransactions ? "up" : "down", tone: avgBasketOverall >= previousRevenue / previousTransactions ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow}`}>
        <RankingTableCard
          id="cashier-leaderboard"
          title="Cashier Leaderboard"
          rows={visibleCashiers}
          rowKey={(r) => r.userId}
          primaryHeader="Cashier"
          primaryLabel={(r) => r.name}
          barHeader="Revenue"
          barValue={(r) => r.revenueN}
          barLabel={(r) => formatMoney(r.revenueN)}
          extraColumns={[
            { key: "transactions", header: "Transactions", align: "right", render: (r) => r.transactions.toLocaleString("en-IN") },
            { key: "avgBasket", header: "Avg Basket", align: "right", render: (r) => formatMoney(r.avgBasketN) },
            { key: "discountRate", header: "Discount Rate", align: "right", render: (r) => <StatusBadge status={discountTone(r.discountRateN)} variant={discountTone(r.discountRateN)} label={`${r.discountRateN.toFixed(1)}%`} /> },
            { key: "corrections", header: "Voids/Corrections", align: "right", render: (r) => r.corrections },
          ]}
          loading={loading}
          emptyTitle="No sales in this range"
          pageSize={leaderboardExpanded ? LEADERBOARD_PAGE_SIZE : undefined}
          footer={
            sortedCashiers.length > LEADERBOARD_PREVIEW_SIZE ? (
              <div className={css.cardFooterLink}>
                <button type="button" className={css.cardLink} onClick={() => setLeaderboardExpanded((v) => !v)}>
                  {leaderboardExpanded ? "Show top 5 only" : "View full leaderboard"}
                  <IconChevronRight size={13} />
                </button>
              </div>
            ) : undefined
          }
        />

        <ActionsPanel title="Coaching & Monitoring" items={coachingItems} variant="cards" onViewAll={scrollToShiftPerformance} />
      </div>

      <div className={`${css.dailySalesRow} ${css.alignStart}`}>
        <ShiftPerformanceCard id="shift-performance" shifts={shiftData} metric={shiftMetric} onMetricChange={setShiftMetric} />

        <ActionsPanel title="Shift Insights" items={shiftInsightItems} variant="cards" />
      </div>
    </div>
  );
}
