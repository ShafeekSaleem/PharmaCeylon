"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronUp,
  IconCheckCircle,
  IconCloudSun,
  IconDollarSign,
  IconMoon,
  IconSearch,
  IconShield,
  IconShoppingBag,
  IconSun,
  IconTag,
  IconTrophy,
  IconUsers,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { InlineBarCell } from "../components/inline-bar-cell";
import { fetchCashierAggregateComparison } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { CashierThroughputMatrix, type CashierMatrixPoint } from "../components/cashier-throughput-matrix";
import { ShiftPerformanceCard, type ShiftDatum, type ShiftIconTone, type ShiftMetric } from "../components/shift-performance-card";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { CashierRow, ExportPayload, OnExportData, Scope, ShiftRow } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

type EnrichedCashier = CashierRow & { revenueN: number; avgBasketN: number; discountRateN: number };

/** Same palette Branch Sales' own matrix/trend chart use — a cashier reads as one consistent
 *  color across the Cashier Comparison matrix and (were it ever reused elsewhere) any other chart
 *  on this page, the same "one entity, one color" convention the rest of this redesign follows. */
const CASHIER_PALETTE = ["#0d9488", "#0891b2", "#7c3aed", "#ea580c", "#16a34a", "#c2410c", "#64748b"];

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

/** Lower is better here, unlike most StatCard tones — a rising exception rate is worse, not
 *  better, so this feeds a static severity color rather than a directional up/down trend. */
function exceptionRateTone(pct: number): "success" | "warning" | "danger" {
  if (pct >= 5) return "danger";
  if (pct >= 2) return "warning";
  return "success";
}

export function CashierPerformanceSection({ scope, isOwner, days, onExportData }: Props) {
  const [cashiers, setCashiers] = useState<EnrichedCashier[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [previousRevenue, setPreviousRevenue] = useState(0);
  const [previousTransactions, setPreviousTransactions] = useState(0);
  const [previousActiveCashierCount, setPreviousActiveCashierCount] = useState(0);
  const [selectedCashierId, setSelectedCashierId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [shiftMetric, setShiftMetric] = useState<ShiftMetric>("revenue");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedCashierId(null);
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
  const colorMap = useMemo(() => new Map(sortedCashiers.map((c, i) => [c.userId, CASHIER_PALETTE[i % CASHIER_PALETTE.length]!])), [sortedCashiers]);

  const totalRevenue = cashiers.reduce((s, c) => s + c.revenueN, 0);
  const totalTxns = cashiers.reduce((s, c) => s + c.transactions, 0);
  const txnsPerCashier = cashiers.length > 0 ? totalTxns / cashiers.length : 0;
  const avgBasketOverall = totalTxns > 0 ? totalRevenue / totalTxns : 0;

  const avgDiscountRate = cashiers.length > 0 ? cashiers.reduce((s, c) => s + c.discountRateN, 0) / cashiers.length : 0;
  const avgCorrectionRate = cashiers.length > 0 ? cashiers.reduce((s, c) => s + (c.transactions > 0 ? c.corrections / c.transactions : 0), 0) / cashiers.length : 0;
  const exceptionRatePct = avgCorrectionRate * 100;

  const topPerformer = sortedCashiers[0] ?? null;
  const needsSupport = [...cashiers].filter((c) => c.transactions > 0).sort((a, b) => a.revenueN - b.revenueN)[0] ?? null;
  const highestBasketCashier = cashiers.length > 0 ? [...cashiers].filter((c) => c.transactions > 0).sort((a, b) => b.avgBasketN - a.avgBasketN)[0] ?? null : null;
  const unusualDiscount = cashiers.filter((c) => c.discountRateN > avgDiscountRate * 1.5 && c.discountRateN > 5);
  const highVoidRate = cashiers.filter((c) => c.transactions > 0 && c.corrections / c.transactions > Math.max(0.05, avgCorrectionRate * 1.5));

  function scrollToComparison() {
    document.getElementById("cashier-comparison")?.scrollIntoView({ behavior: "smooth" });
  }
  function scrollToDetail() {
    document.getElementById("cashier-detail")?.scrollIntoView({ behavior: "smooth" });
  }
  function scrollToShiftPerformance() {
    document.getElementById("shift-performance")?.scrollIntoView({ behavior: "smooth" });
  }
  function toggleCashierFilter(userId: string) {
    setSelectedCashierId((cur) => (cur === userId ? null : userId));
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
          onClick: scrollToDetail,
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
          onClick: scrollToDetail,
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
          onClick: scrollToDetail,
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
          onClick: scrollToDetail,
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
          onClick: scrollToDetail,
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

  const matrixPoints: CashierMatrixPoint[] = useMemo(
    () => sortedCashiers.map((c) => ({ id: c.userId, label: c.name, transactions: c.transactions, avgBasket: c.avgBasketN, revenue: c.revenueN })),
    [sortedCashiers],
  );

  const filteredCashiers = useMemo(() => {
    let out = selectedCashierId ? sortedCashiers.filter((c) => c.userId === selectedCashierId) : sortedCashiers;
    if (search) out = out.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
    return out;
  }, [sortedCashiers, selectedCashierId, search]);

  const maxRevenue = Math.max(...cashiers.map((c) => c.revenueN), 1);

  const detailColumns: Column<EnrichedCashier>[] = useMemo(
    () => [
      { key: "name", header: "Cashier" },
      {
        key: "revenueN",
        header: "Revenue",
        align: "right",
        sortable: true,
        getValue: (r) => r.revenueN,
        render: (r) => <InlineBarCell valueLabel={formatMoney(r.revenueN)} pct={(r.revenueN / maxRevenue) * 100} />,
      },
      { key: "transactions", header: "Transactions", align: "right", sortable: true, getValue: (r) => r.transactions, render: (r) => r.transactions.toLocaleString("en-IN") },
      { key: "avgBasketN", header: "Avg Basket", align: "right", sortable: true, getValue: (r) => r.avgBasketN, render: (r) => formatMoney(r.avgBasketN) },
      {
        key: "discountRateN",
        header: "Discount Rate",
        align: "right",
        sortable: true,
        getValue: (r) => r.discountRateN,
        render: (r) => <StatusBadge status={discountTone(r.discountRateN)} variant={discountTone(r.discountRateN)} label={`${r.discountRateN.toFixed(1)}%`} />,
      },
      { key: "corrections", header: "Voids/Corrections", align: "right", sortable: true, getValue: (r) => r.corrections, render: (r) => r.corrections },
    ],
    [maxRevenue],
  );

  if (error) return <div className={css.errorState}>{error}</div>;

  const selectedCashierName = selectedCashierId ? cashiers.find((c) => c.userId === selectedCashierId)?.name : undefined;
  const filterPills: FilterPill[] = selectedCashierName ? [{ key: "cashier", label: selectedCashierName }] : [];

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
        <StatCard
          size="sm" showMenu={false}
          title="Exception Rate"
          value={loading ? "…" : `${exceptionRatePct.toFixed(1)}%`}
          subtitle="Voids/corrections ÷ transactions, per cashier"
          icon={<IconShield size={16} />}
          iconTone={loading ? "info" : exceptionRateTone(exceptionRatePct)}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow} ${css.gridAlignStart}`}>
        <div className={css.card} id="cashier-comparison">
          <div className={css.cardhead}>
            <div>
              <h3>Cashier Comparison</h3>
              <p>Transactions × avg. basket — bubble size = revenue</p>
            </div>
          </div>
          <CashierThroughputMatrix points={matrixPoints} formatValue={formatMoney} colorFor={(id) => colorMap.get(id) ?? "#64748b"} onBubbleClick={toggleCashierFilter} activeId={selectedCashierId} />
        </div>

        <ActionsPanel title="Coaching & Monitoring" items={coachingItems} variant="cards" onViewAll={scrollToShiftPerformance} />
      </div>

      <div className={`${css.dailySalesRow} ${css.alignStart}`}>
        <ShiftPerformanceCard id="shift-performance" shifts={shiftData} metric={shiftMetric} onMetricChange={setShiftMetric} />

        <ActionsPanel title="Shift Insights" items={shiftInsightItems} variant="cards" />
      </div>

      <div className={css.card} id="cashier-detail">
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>Cashier Detail</h3>
          <div className={css.toolbarActions}>
            <div className={css.searchbox}>
              <IconSearch size={14} />
              <input placeholder="Search cashier" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </div>
        {selectedCashierName ? (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={`Filtered by cashier · ${filteredCashiers.length} row${filteredCashiers.length === 1 ? "" : "s"}`}
              pills={filterPills}
              onClear={() => setSelectedCashierId(null)}
              clearTooltip="Show every cashier"
            />
          </div>
        ) : null}
        <DataTable columns={detailColumns} data={filteredCashiers} rowKey={(r) => r.userId} loading={loading} pageSize={10} emptyTitle="No sales in this range" compact />
      </div>
    </div>
  );
}
