"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  IconActivity,
  IconAlertTriangle,
  IconArchive,
  IconBox,
  IconCheckCircle,
  IconChevronRight,
  IconDollarSign,
  IconGrid,
  IconPill,
  IconShield,
  IconShoppingBag,
  IconSparkles,
  IconStethoscope,
  IconTrophy,
  IconUser,
  IconUsers,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { ActionButton } from "@/components/ui";
import {
  fetchCategoryComparison,
  fetchMarginComparison,
  fetchProfitabilityTarget,
  fetchReturnsAndDiscounts,
  fetchSalesTrendWithComparison,
  type MarginTotals,
} from "../lib/fetchers";
import { formatMoney, formatPctTrend, formatPpTrend, pctChange, ppChange } from "../lib/format";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { TrendChart } from "../components/trend-chart";
import { WaterfallChart, type WaterfallStep } from "../components/waterfall-chart";
import { MarginGauge } from "../components/margin-gauge";
import { InlineBarCell } from "../components/inline-bar-cell";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { BranchTrendPoint, CategoryRow, ExportPayload, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

type CategoryEnriched = CategoryRow & { revenueN: number; costN: number; marginN: number; marginPct: number; growthPct: number | null };

/** Best-effort department → icon mapping (cosmetic only, matched on display name) — this
 *  codebase's icon set has no per-department icons, so this picks the closest fit. */
const DEPARTMENT_ICONS: Record<string, ReactNode> = {
  Medicines: <IconPill size={16} />,
  "Vitamins & Supplements": <IconArchive size={16} />,
  "Baby & Mother Care": <IconUsers size={16} />,
  "Personal Care": <IconUser size={16} />,
  "Beauty & Skin Care": <IconSparkles size={16} />,
  "Medical Devices": <IconStethoscope size={16} />,
  "First Aid": <IconShield size={16} />,
  "Nutrition & Wellness": <IconActivity size={16} />,
  "Food & Beverages": <IconShoppingBag size={16} />,
  "Household & Convenience": <IconBox size={16} />,
};
const DRIVER_ICON_TONES = ["primary", "info", "success", "warning"] as const;

function driverIcon(name: string): ReactNode {
  return DEPARTMENT_ICONS[name] ?? <IconGrid size={16} />;
}

/** Executive profitability overview — owns Revenue/COGS/Gross Profit/Blended Margin, the profit
 *  bridge, and the goal tracker. Category and product-level detail intentionally live on Margin
 *  by Category / Margin by Product instead of being duplicated here. */
export function GrossProfitSection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const router = useRouter();
  const [currentTotals, setCurrentTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [previousTotals, setPreviousTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [revenuePoints, setRevenuePoints] = useState<BranchTrendPoint[]>([]);
  const [previousRevenuePoints, setPreviousRevenuePoints] = useState<BranchTrendPoint[]>([]);
  const [categories, setCategories] = useState<CategoryEnriched[]>([]);
  const [totalReturns, setTotalReturns] = useState(0);
  const [targetPct, setTargetPct] = useState<number | null>(null);
  const [targetLoaded, setTargetLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchMarginComparison(days, scope, isOwner),
      fetchSalesTrendWithComparison(days, scope, null),
      fetchCategoryComparison(days, scope, isOwner),
      fetchReturnsAndDiscounts(days, scope, isOwner),
    ])
      .then(([margin, trend, cats, returns]) => {
        if (cancelled) return;
        setCurrentTotals(margin.currentTotals);
        setPreviousTotals(margin.previousTotals);
        setRevenuePoints(trend.currentPoints);
        setPreviousRevenuePoints(trend.previousPoints);
        setTotalReturns(returns.totalReturnValue);
        setCategories(
          cats.current.map((c) => {
            const revenueN = Number(c.revenue);
            const costN = Number(c.cost);
            const marginN = revenueN - costN;
            const prev = cats.previousByCategory.get(c.categoryId);
            return { ...c, revenueN, costN, marginN, marginPct: revenueN > 0 ? (marginN / revenueN) * 100 : 0, growthPct: prev ? pctChange(revenueN, prev.revenue) : null };
          }),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load gross profit data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  useEffect(() => {
    let cancelled = false;
    fetchProfitabilityTarget()
      .then((res) => {
        if (!cancelled) setTargetPct(res.targetGrossMarginPercent);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTargetLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const blendedMarginPct = currentTotals.revenue > 0 ? (currentTotals.margin / currentTotals.revenue) * 100 : 0;
  const previousBlendedMarginPct = previousTotals.revenue > 0 ? (previousTotals.margin / previousTotals.revenue) * 100 : 0;

  // No daily cost ledger exists, so the daily trend applies the period's blended margin% uniformly —
  // an estimate, not an exact day-by-day figure. Said so explicitly in the card subtitle.
  const estimatedProfitPoints = useMemo(() => revenuePoints.map((p) => ({ ...p, value: p.value * (blendedMarginPct / 100) })), [revenuePoints, blendedMarginPct]);
  const estimatedPreviousProfitPoints = useMemo(() => previousRevenuePoints.map((p) => ({ ...p, value: p.value * (previousBlendedMarginPct / 100) })), [previousRevenuePoints, previousBlendedMarginPct]);
  const bucketedCurrent = useMemo(() => bucketTrend(estimatedProfitPoints, granularity), [estimatedProfitPoints, granularity]);
  const bucketedPrevious = useMemo(() => bucketTrend(estimatedPreviousProfitPoints, granularity), [estimatedPreviousProfitPoints, granularity]);

  const bestCategory = [...categories].sort((a, b) => b.marginN - a.marginN)[0] ?? null;

  const actionItems: ActionPanelItem[] = useMemo(() => {
    const out: ActionPanelItem[] = [];
    if (bestCategory) {
      const shareOfProfit = currentTotals.margin > 0 ? (bestCategory.marginN / currentTotals.margin) * 100 : 0;
      out.push({
        key: "best-category",
        icon: <IconTrophy size={16} />,
        tone: "primary",
        title: "Best Contributor Category",
        description: `${bestCategory.name} contributed ${formatMoney(bestCategory.marginN)} gross profit (${shareOfProfit.toFixed(1)}% of total).`,
        count: 1,
        countLabel: "category",
        examples: [{ label: bestCategory.name, badge: `${shareOfProfit.toFixed(0)}% of profit`, tone: "positive" }],
      });
    }
    if (previousTotals.revenue > 0) {
      const revenueDelta = currentTotals.revenue - previousTotals.revenue;
      const profitDelta = currentTotals.margin - previousTotals.margin;
      out.push({
        key: "driver",
        icon: <IconActivity size={16} />,
        tone: profitDelta >= 0 ? "primary" : "danger",
        title: "Gross Profit Change Driver",
        description: `Revenue ${revenueDelta >= 0 ? "increased" : "decreased"} by ${formatMoney(Math.abs(revenueDelta))} (${formatPctTrend(pctChange(currentTotals.revenue, previousTotals.revenue))}), leading to a ${formatMoney(Math.abs(profitDelta))} gross-profit ${profitDelta >= 0 ? "increase" : "decrease"}.`,
        count: 1,
        countLabel: "period",
        examples: [{ label: "Revenue", badge: formatPctTrend(pctChange(currentTotals.revenue, previousTotals.revenue)), tone: revenueDelta >= 0 ? "positive" : "negative" }],
      });
    }
    const topOpportunity = [...categories].filter((c) => c.growthPct != null && c.growthPct > 0).sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0))[0];
    if (topOpportunity) {
      out.push({
        key: "opportunity",
        icon: <IconSparkles size={16} />,
        tone: "purple",
        title: "Top Opportunity",
        description: `${topOpportunity.name} has the highest growth this period (${formatPctTrend(topOpportunity.growthPct ?? 0)}).`,
        count: 1,
        countLabel: "category",
        onClick: () => onNavigate("profitability", "margin-by-category"),
        examples: [{ label: topOpportunity.name, badge: formatPctTrend(topOpportunity.growthPct ?? 0), tone: "positive" }],
      });
    }
    return out;
  }, [bestCategory, previousTotals, currentTotals, categories, onNavigate]);

  const rankedByMargin = useMemo(() => [...categories].sort((a, b) => b.marginN - a.marginN), [categories]);
  const topDrivers = rankedByMargin.slice(0, 4);
  const contributionRows = rankedByMargin.slice(0, 8);

  const waterfallSteps: WaterfallStep[] = [
    { key: "revenue", label: "Revenue", kind: "total", value: currentTotals.revenue },
    { key: "cogs", label: "Cost of Goods Sold", kind: "deduction", value: currentTotals.cost },
    { key: "gp", label: "Gross Profit", kind: "total", value: currentTotals.margin },
  ];

  useEffect(() => {
    if (rankedByMargin.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `gross-profit-${days}d.csv`,
      headers: ["Category", "Revenue", "COGS", "Gross Profit", "Margin %", "Contribution %", "Growth %"],
      rows: rankedByMargin.map((c) => [
        c.name,
        c.revenueN,
        c.costN,
        c.marginN,
        c.marginPct.toFixed(1),
        currentTotals.margin > 0 ? ((c.marginN / currentTotals.margin) * 100).toFixed(1) : "0",
        c.growthPct?.toFixed(1) ?? "",
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [rankedByMargin, currentTotals.margin, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Revenue"
          value={loading ? "…" : formatMoney(currentTotals.revenue)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          trend={!loading && previousTotals.revenue > 0 ? { value: formatPctTrend(pctChange(currentTotals.revenue, previousTotals.revenue)), direction: currentTotals.revenue >= previousTotals.revenue ? "up" : "down", tone: currentTotals.revenue >= previousTotals.revenue ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Cost of Goods Sold"
          value={loading ? "…" : formatMoney(currentTotals.cost)}
          subtitle={`vs previous ${days} days`}
          icon={<IconArchive size={16} />}
          iconTone="warning"
          trend={!loading && previousTotals.cost > 0 ? { value: formatPctTrend(pctChange(currentTotals.cost, previousTotals.cost)), direction: currentTotals.cost >= previousTotals.cost ? "up" : "down", tone: currentTotals.cost >= previousTotals.cost ? "danger" : "positive" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Gross Profit"
          value={loading ? "…" : formatMoney(currentTotals.margin)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          iconTone="success"
          trend={!loading && previousTotals.margin !== 0 ? { value: formatPctTrend(pctChange(currentTotals.margin, previousTotals.margin)), direction: currentTotals.margin >= previousTotals.margin ? "up" : "down", tone: currentTotals.margin >= previousTotals.margin ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Gross Margin"
          value={loading ? "…" : `${blendedMarginPct.toFixed(1)}%`}
          subtitle={`vs previous ${days} days`}
          icon={<IconPill size={16} />}
          trend={!loading && previousTotals.revenue > 0 ? { value: formatPpTrend(ppChange(blendedMarginPct, previousBlendedMarginPct)), direction: blendedMarginPct >= previousBlendedMarginPct ? "up" : "down", tone: blendedMarginPct >= previousBlendedMarginPct ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Gross Profit Trend</h3>
              <p>Estimated from daily revenue × the period&apos;s blended margin — actual cost isn&apos;t tracked day-by-day.</p>
            </div>
            <div className={css.segmented}>
              {(["daily", "weekly", "monthly"] as ChartGranularity[]).map((g) => (
                <button key={g} type="button" className={granularity === g ? css.on : undefined} onClick={() => setGranularity(g)}>
                  {g === "daily" ? "Daily" : g === "weekly" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
          </div>
          <TrendChart points={bucketedCurrent} previousPoints={bucketedPrevious} tooltipFormat={formatMoney} currentLabel={`Last ${days} days`} previousLabel={`Previous ${days} days`} />
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Profit Bridge</h3>
              <p>How revenue becomes gross profit</p>
            </div>
          </div>
          <WaterfallChart steps={waterfallSteps} formatValue={formatMoney} />
          {totalReturns > 0 ? (
            <p className={css.bridgeNote}>
              {formatMoney(totalReturns)} in customer returns this period aren&apos;t reflected above (line-level discounts already are, inside Revenue) — see{" "}
              <button type="button" className={css.inlineLinkBtn} onClick={() => onNavigate("sales", "returns-discounts")}>
                Returns &amp; Discounts
              </button>
              .
            </p>
          ) : null}
        </div>
      </div>

      <div className={css.grid3}>
        <div className={`${css.card} ${css.compactCard}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Profitability Goal Tracker</h3>
              <p>Gross margin target for this period</p>
            </div>
          </div>
          <div className={css.compactCardBody}>
            {targetLoaded && targetPct == null ? (
              <MarginGauge
                actualPct={blendedMarginPct}
                targetPct={targetPct}
                emptyState={
                  <>
                    <p className={css.emptyNote}>No profitability target set yet.</p>
                    <Link href="/settings/profitability" className={css.cardLink}>
                      Set a goal <IconChevronRight size={13} />
                    </Link>
                  </>
                }
              />
            ) : null}
            {targetLoaded && targetPct != null ? (
              <div className={css.goalTrackerRow}>
                <div className={css.goalTrackerLeft}>
                  <MarginGauge actualPct={blendedMarginPct} targetPct={targetPct} emptyState={null} />
                </div>
                <div className={css.goalTrackerRight}>
                  <div className={`${css.goalMessageBox} ${blendedMarginPct >= targetPct ? css.goalMessageSuccess : css.goalMessageWarning}`}>
                    <span className={css.goalMessageIcon}>
                      {blendedMarginPct >= targetPct ? <IconCheckCircle size={15} /> : <IconAlertTriangle size={15} />}
                    </span>
                    <div>
                      <b>{blendedMarginPct >= targetPct ? "Great job! You've exceeded your gross margin target." : "Below target margin this period."}</b>
                      <p>
                        {blendedMarginPct >= targetPct
                          ? "Keep optimizing COGS and pricing to sustain growth."
                          : `Review pricing and COGS to close the ${Math.abs(ppChange(blendedMarginPct, targetPct)).toFixed(1)}pp gap.`}
                      </p>
                    </div>
                  </div>
                  <ActionButton variant="secondary" onClick={() => router.push("/settings/profitability")}>
                    View Goal Settings
                  </ActionButton>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className={`${css.card} ${css.compactCard}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Profitability Drivers</h3>
              <p>Top commercial departments by gross profit</p>
            </div>
          </div>
          <div className={css.compactCardBody}>
            {topDrivers.length === 0 ? (
              <p className={css.emptyNote}>No categorized sales in this range yet.</p>
            ) : (
              <StatGrid columns={2} dense>
                {topDrivers.map((d, i) => (
                  <StatCard
                    key={d.categoryId}
                    size="sm"
                    showMenu={false}
                    title={d.name}
                    value={`${d.marginPct.toFixed(1)}%`}
                    subtitle={formatMoney(d.marginN)}
                    icon={driverIcon(d.name)}
                    iconTone={DRIVER_ICON_TONES[i % DRIVER_ICON_TONES.length]}
                    trend={d.growthPct != null ? { value: formatPctTrend(d.growthPct), direction: d.growthPct >= 0 ? "up" : "down", tone: d.growthPct >= 0 ? "positive" : "danger" } : undefined}
                  />
                ))}
              </StatGrid>
            )}
          </div>
        </div>

        <ActionsPanel title="Profitability Insights" items={actionItems} variant="cards" pageSize={3} />
      </div>

      <div className={css.card}>
        <div className={css.cardhead}>
          <div>
            <h3>Gross Profit Contribution by Commercial Category</h3>
            <p>Share of gross profit by category</p>
          </div>
          <button type="button" className={css.cardLink} onClick={() => onNavigate("profitability", "margin-by-category")}>
            View margin by category <IconChevronRight size={13} />
          </button>
        </div>
        {contributionRows.length === 0 ? (
          <p className={css.emptyNote}>No categorized sales in this range yet.</p>
        ) : (
          <div className={css.contribList}>
            {contributionRows.map((c) => {
              const contributionPct = currentTotals.margin > 0 ? (c.marginN / currentTotals.margin) * 100 : 0;
              return (
                <div key={c.categoryId} className={css.contribRow}>
                  <span className={css.contribName}>{c.name}</span>
                  <InlineBarCell valueLabel={formatMoney(c.marginN)} pct={contributionPct} />
                  <span className={css.contribPct}>{contributionPct.toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
