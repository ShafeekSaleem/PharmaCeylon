"use client";

import { useEffect, useMemo, useState } from "react";
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
  IconHome,
  IconPill,
  IconSparkles,
  IconTrophy,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { ActionButton } from "@/components/ui";
import { getCategoryVisual, getCategoryStatTone } from "@/lib/category-icons";
import {
  fetchBranchMargin,
  fetchCategoryComparison,
  fetchMarginComparison,
  fetchSalesTrendWithComparison,
  type MarginTotals,
} from "../lib/fetchers";
import { useProfitabilityTarget } from "../lib/use-profitability-target";
import { formatMoney, formatPctTrend, formatPpTrend, pctChange, ppChange } from "../lib/format";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { TrendChart } from "../components/trend-chart";
import { WaterfallChart, type WaterfallStep } from "../components/waterfall-chart";
import { MarginVsTarget } from "../components/margin-vs-target";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { BranchMarginRow, BranchTrendPoint, CategoryRow, ExportPayload, MarginRow, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

type CategoryEnriched = CategoryRow & {
  revenueN: number;
  costN: number;
  marginN: number;
  marginPct: number;
  growthPct: number | null;
  /** Null when there's no comparable prior-period revenue for this category — never fabricated. */
  previousMarginPct: number | null;
};

/** Executive profitability overview — owns Net Revenue/COGS/Gross Profit/Blended Margin, the
 *  change bridge, and target tracking. Full category/product/branch drill-down intentionally
 *  lives on their own dedicated pages; this page links out to them rather than duplicating. */
export function GrossProfitSection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const router = useRouter();
  const [currentTotals, setCurrentTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [previousTotals, setPreviousTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [revenuePoints, setRevenuePoints] = useState<BranchTrendPoint[]>([]);
  const [previousRevenuePoints, setPreviousRevenuePoints] = useState<BranchTrendPoint[]>([]);
  const [categories, setCategories] = useState<CategoryEnriched[]>([]);
  const [productRows, setProductRows] = useState<MarginRow[]>([]);
  const [branchRows, setBranchRows] = useState<BranchMarginRow[]>([]);
  const { targetPct, targetLoaded } = useProfitabilityTarget();
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
    ])
      .then(([margin, trend, cats]) => {
        if (cancelled) return;
        setCurrentTotals(margin.currentTotals);
        setPreviousTotals(margin.previousTotals);
        setRevenuePoints(trend.currentPoints);
        setPreviousRevenuePoints(trend.previousPoints);
        setProductRows(margin.current);
        setCategories(
          cats.current.map((c) => {
            const revenueN = Number(c.revenue);
            const costN = Number(c.cost);
            const marginN = revenueN - costN;
            const prev = cats.previousByCategory.get(c.categoryId);
            const previousMarginPct = prev && prev.revenue > 0 ? (prev.margin / prev.revenue) * 100 : null;
            return { ...c, revenueN, costN, marginN, marginPct: revenueN > 0 ? (marginN / revenueN) * 100 : 0, growthPct: prev ? pctChange(revenueN, prev.revenue) : null, previousMarginPct };
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

  // Independent of scope/branch — Branch Profitability's own endpoint always covers every branch
  // (see `fetchBranchMargin`'s doc comment), used here only to surface a "Top Branch" contributor
  // tile when the tenant genuinely has more than one.
  useEffect(() => {
    let cancelled = false;
    fetchBranchMargin(days)
      .then((res) => {
        if (!cancelled) setBranchRows(res.branches);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [days]);

  const blendedMarginPct = currentTotals.revenue > 0 ? (currentTotals.margin / currentTotals.revenue) * 100 : 0;
  const previousBlendedMarginPct = previousTotals.revenue > 0 ? (previousTotals.margin / previousTotals.revenue) * 100 : 0;

  // No daily cost ledger exists, so the daily trend applies the period's blended margin% uniformly —
  // an estimate, not an exact day-by-day figure. Said so explicitly in the card subtitle.
  const estimatedProfitPoints = useMemo(() => revenuePoints.map((p) => ({ ...p, value: p.value * (blendedMarginPct / 100) })), [revenuePoints, blendedMarginPct]);
  const estimatedPreviousProfitPoints = useMemo(() => previousRevenuePoints.map((p) => ({ ...p, value: p.value * (previousBlendedMarginPct / 100) })), [previousRevenuePoints, previousBlendedMarginPct]);
  const bucketedCurrent = useMemo(() => bucketTrend(estimatedProfitPoints, granularity), [estimatedProfitPoints, granularity]);
  const bucketedPrevious = useMemo(() => bucketTrend(estimatedPreviousProfitPoints, granularity), [estimatedPreviousProfitPoints, granularity]);

  const rankedByMargin = useMemo(() => [...categories].sort((a, b) => b.marginN - a.marginN), [categories]);
  const bestCategory = rankedByMargin[0] ?? null;
  const topProduct = useMemo(() => (productRows.length === 0 ? null : [...productRows].sort((a, b) => Number(b.margin) - Number(a.margin))[0]!), [productRows]);
  // Only surfaced (a) once there are genuinely 2+ branches to compare, and (b) while viewing "All
  // branches" — `branchRows` always covers the whole tenant regardless of the page's own scope
  // toggle, but `currentTotals` (the "% of profit" denominator below) is THIS branch's own total
  // when scoped to one branch, so a cross-branch comparison against it would be nonsense (another
  // branch's margin divided by this branch's total — not even guaranteed to stay under 100%).
  const topBranch = useMemo(
    () => (scope !== "tenant" || branchRows.length < 2 ? null : [...branchRows].sort((a, b) => Number(b.margin) - Number(a.margin))[0]!),
    [scope, branchRows],
  );

  // The category with the steepest own-margin decline vs. the comparison period (not just the
  // slowest revenue growth) — a genuine risk signal a reader can't already see on the trend/bridge
  // charts above, which only show the portfolio's blended figures.
  const marginErosion = useMemo(() => {
    const candidates = categories
      .filter((c): c is CategoryEnriched & { previousMarginPct: number } => c.previousMarginPct != null && c.revenueN > 0)
      .map((c) => ({ c, deltaPp: c.marginPct - c.previousMarginPct }));
    const worst = candidates.sort((a, b) => a.deltaPp - b.deltaPp)[0];
    // 1pp+ decline only — smaller moves are noise, not a real erosion signal worth flagging.
    return worst && worst.deltaPp < -1 ? worst : null;
  }, [categories]);

  const actionItems: ActionPanelItem[] = useMemo(() => {
    const out: ActionPanelItem[] = [];
    if (bestCategory) {
      const shareOfProfit = currentTotals.margin > 0 ? (bestCategory.marginN / currentTotals.margin) * 100 : 0;
      const marginGapPp = bestCategory.marginPct - blendedMarginPct;
      out.push({
        key: "best-category",
        icon: <IconTrophy size={16} />,
        tone: "primary",
        title: "Best Contributor Category",
        description: `${bestCategory.name} generates ${shareOfProfit.toFixed(1)}% of gross profit at a ${bestCategory.marginPct.toFixed(1)}% margin — ${Math.abs(marginGapPp).toFixed(1)}pp ${marginGapPp >= 0 ? "above" : "below"} the portfolio average, making it ${marginGapPp >= 0 ? "a genuine profit engine, not just a volume driver" : "disproportionately important to protect despite thinner margins"}.`,
        count: 1,
        countLabel: "category",
        onClick: () => onNavigate("profitability", "margin-by-category"),
        examples: [{ label: bestCategory.name, badge: `${shareOfProfit.toFixed(0)}% of profit`, tone: "positive" }],
      });
    }
    if (previousTotals.revenue > 0) {
      // previousTotals.revenue > 0 already guarantees pctChange's only-null case (zero prior
      // value) can't happen here — the `?? 0` is just satisfying the general signature.
      const revenueGrowthPct = pctChange(currentTotals.revenue, previousTotals.revenue) ?? 0;
      const costGrowthPct = (previousTotals.cost > 0 ? pctChange(currentTotals.cost, previousTotals.cost) : 0) ?? 0;
      const marginPtDelta = blendedMarginPct - previousBlendedMarginPct;
      const costOutpacing = costGrowthPct > revenueGrowthPct;
      out.push({
        key: "driver",
        icon: <IconActivity size={16} />,
        tone: marginPtDelta >= 0 ? "primary" : "danger",
        title: costOutpacing ? "Cost Pressure on Margin" : "Margin Expansion Driver",
        description: costOutpacing
          ? `Gross margin ${marginPtDelta >= 0 ? "held roughly flat" : `fell ${Math.abs(marginPtDelta).toFixed(1)}pp`} because COGS grew ${formatPctTrend(costGrowthPct)} — faster than revenue's ${formatPctTrend(revenueGrowthPct)} — eating into the gain.`
          : `Gross margin ${marginPtDelta >= 0 ? `improved ${marginPtDelta.toFixed(1)}pp` : "held roughly flat"} as revenue grew ${formatPctTrend(revenueGrowthPct)}, outpacing COGS' ${formatPctTrend(costGrowthPct)} growth.`,
        count: 1,
        countLabel: "period",
        examples: [{ label: "Margin", badge: formatPpTrend(marginPtDelta), tone: marginPtDelta >= 0 ? "positive" : "negative" }],
      });
    }
    if (marginErosion) {
      const { c, deltaPp } = marginErosion;
      const revenueContext = c.growthPct == null ? "" : c.growthPct >= 0 ? `, despite revenue ${c.growthPct === 0 ? "holding steady" : `growing ${formatPctTrend(c.growthPct)}`}` : "";
      out.push({
        key: "erosion",
        icon: <IconAlertTriangle size={16} />,
        tone: "danger",
        title: "Margin Erosion",
        description: `${c.name}'s margin slipped ${Math.abs(deltaPp).toFixed(1)}pp to ${c.marginPct.toFixed(1)}% versus the comparison period${revenueContext} — cost pressure here is outrunning pricing.`,
        count: 1,
        countLabel: "category",
        onClick: () => onNavigate("profitability", "margin-by-category"),
        examples: [{ label: c.name, badge: `${deltaPp.toFixed(1)}pp`, tone: "negative" }],
      });
    } else {
      const topOpportunity = [...categories].filter((c) => c.growthPct != null && c.growthPct > 0).sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0))[0];
      if (topOpportunity) {
        out.push({
          key: "opportunity",
          icon: <IconSparkles size={16} />,
          tone: "purple",
          title: "Top Growth Opportunity",
          description: `${topOpportunity.name} grew ${formatPctTrend(topOpportunity.growthPct ?? 0)} this period at a ${topOpportunity.marginPct.toFixed(1)}% margin — worth doubling down on while the momentum holds.`,
          count: 1,
          countLabel: "category",
          onClick: () => onNavigate("profitability", "margin-by-category"),
          examples: [{ label: topOpportunity.name, badge: formatPctTrend(topOpportunity.growthPct ?? 0), tone: "positive" }],
        });
      }
    }
    return out;
  }, [bestCategory, previousTotals, currentTotals, categories, blendedMarginPct, previousBlendedMarginPct, marginErosion, onNavigate]);

  // "Why did gross profit change" (period-over-period attribution), not "how does revenue become
  // gross profit" (composition) — the KPI cards already show revenue/COGS/GP in full, so a
  // composition bridge repeats them without adding anything. `previousTotals.margin` is a "total"
  // step (overwrites the running baseline directly, see WaterfallChart), so this stays pixel-exact
  // regardless of Decimal/float rounding in the intermediate deltas.
  const revenueDelta = currentTotals.revenue - previousTotals.revenue;
  const costDelta = currentTotals.cost - previousTotals.cost;
  const hasComparablePeriod = previousTotals.revenue > 0;
  const waterfallSteps: WaterfallStep[] = [
    { key: "prevGp", label: "Previous Period GP", kind: "total", value: previousTotals.margin },
    { key: "revenueDelta", label: "Revenue Δ", kind: revenueDelta >= 0 ? "addition" : "deduction", value: Math.abs(revenueDelta) },
    // Inverted vs. Revenue's mapping — a COGS *increase* reduces gross profit, so a rising cost
    // (costDelta >= 0) is a "deduction" step, the same direction a falling cost would be for revenue.
    { key: "cogsDelta", label: "COGS Δ", kind: costDelta >= 0 ? "deduction" : "addition", value: Math.abs(costDelta) },
    { key: "curGp", label: "Current Period GP", kind: "total", value: currentTotals.margin },
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
          title="Net Revenue"
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

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
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
          <TrendChart points={bucketedCurrent} previousPoints={bucketedPrevious} tooltipFormat={formatMoney} currentLabel={`Last ${days} days`} previousLabel={`Previous ${days} days`} height={214} />
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Gross Profit Change Bridge</h3>
              <p>Why gross profit changed vs. the comparison period</p>
            </div>
          </div>
          {hasComparablePeriod ? (
            <WaterfallChart steps={waterfallSteps} formatValue={formatMoney} />
          ) : (
            <p className={css.emptyNote}>Not enough history yet to show a period-over-period bridge.</p>
          )}
        </div>
      </div>

      <div className={`${css.grid3} ${css.gridAlignStart}`}>
        <div className={`${css.card} ${css.compactCard}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Margin vs Target</h3>
              <p>Gross margin target for this period</p>
            </div>
          </div>
          <div className={css.compactCardBody}>
            {targetLoaded && targetPct == null ? (
              <MarginVsTarget
                actualPct={blendedMarginPct}
                targetPct={targetPct}
                emptyState={
                  <>
                    <p className={css.emptyNote}>No profitability target set yet.</p>
                    <Link href="/settings/catalog" className={css.cardLink}>
                      Set a goal <IconChevronRight size={13} />
                    </Link>
                  </>
                }
              />
            ) : null}
            {targetLoaded && targetPct != null ? (
              <>
                <MarginVsTarget actualPct={blendedMarginPct} targetPct={targetPct} emptyState={null} />
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
                <div className={css.goalActionRow}>
                  <ActionButton variant="secondary" onClick={() => router.push("/settings/catalog")}>
                    View Goal Settings
                  </ActionButton>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className={`${css.card} ${css.compactCard}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Top Profit Contributors</h3>
              <p>Highest gross-profit category, product{topBranch ? " and branch" : ""}</p>
            </div>
          </div>
          <div className={css.compactCardBody}>
            {!bestCategory && !topProduct ? (
              <p className={css.emptyNote}>No categorized sales in this range yet.</p>
            ) : (
              <div className={css.statStack}>
                {bestCategory ? (
                  <StatCard
                    size="sm"
                    showMenu={false}
                    title="Top Category"
                    value={bestCategory.name}
                    subtitle={`${formatMoney(bestCategory.marginN)} · ${currentTotals.margin > 0 ? ((bestCategory.marginN / currentTotals.margin) * 100).toFixed(1) : "0"}% of profit`}
                    icon={(() => { const { Icon } = getCategoryVisual(undefined, bestCategory.name); return <Icon size={16} />; })()}
                    iconTone={getCategoryStatTone(undefined, bestCategory.name)}
                    onClick={() => onNavigate("profitability", "margin-by-category")}
                  />
                ) : null}
                {topProduct ? (
                  <StatCard
                    size="sm"
                    showMenu={false}
                    title="Top Product"
                    value={topProduct.name}
                    subtitle={`${formatMoney(Number(topProduct.margin))} · ${currentTotals.margin > 0 ? ((Number(topProduct.margin) / currentTotals.margin) * 100).toFixed(1) : "0"}% of profit`}
                    icon={<IconBox size={16} />}
                    onClick={() => onNavigate("profitability", "margin-by-product")}
                  />
                ) : null}
                {topBranch ? (
                  <StatCard
                    size="sm"
                    showMenu={false}
                    title="Top Branch"
                    value={topBranch.name}
                    subtitle={`${formatMoney(Number(topBranch.margin))} · ${currentTotals.margin > 0 ? ((Number(topBranch.margin) / currentTotals.margin) * 100).toFixed(1) : "0"}% of profit`}
                    icon={<IconHome size={16} />}
                    onClick={() => onNavigate("profitability", "branch-profitability")}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>

        <ActionsPanel title="Profitability Actions" items={actionItems} variant="cards" pageSize={3} />
      </div>
    </div>
  );
}
