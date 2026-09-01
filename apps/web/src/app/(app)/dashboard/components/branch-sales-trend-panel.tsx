"use client";

import { useEffect, useMemo, useState } from "react";
import { IconActivity, IconBarChart } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { BranchMultiSelect } from "./branch-multi-select";
import { DashboardPanel } from "./dashboard-panel";
import { PeriodToggle } from "./period-toggle";
import { formatCompactAxis, MultiLineChart, type MultiSeries } from "./simple-charts";
import { branchColor } from "../lib/branch-colors";
import css from "../dashboard.module.css";

type Period = "7" | "14" | "30";

type BranchTrendResponse = {
  trendDays: number;
  branches: Array<{
    branchId: string;
    code: string;
    name: string;
    points: Array<{ label: string; date: string; value: number }>;
    total: number;
    previousTotal: number;
  }>;
};

const PERIOD_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
] as const;

/** Chart lines/legend stay readable by capping the *default* (all-branches)
 * view to the top performers — an explicit compare selection is honored in
 * full since that's a deliberate, already-bounded choice. */
const MAX_DEFAULT_BRANCHES = 5;

export function BranchSalesTrendPanel() {
  const [period, setPeriod] = useState<Period>("7");
  const [data, setData] = useState<BranchTrendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  /** Empty == comparing all branches. */
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([]);
  /** null == auto (top performer among the displayed branches). */
  const [focusedBranchId, setFocusedBranchId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiJson<BranchTrendResponse>(`/analytics/branch-sales-trend?days=${period}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  // Color assigned by branch identity (alphabetical), not by rank — so a
  // branch keeps its color when the period toggle reshuffles the totals.
  const colorByBranch = useMemo(() => {
    if (!data) return new Map<string, string>();
    const stable = [...data.branches].sort((a, b) => a.name.localeCompare(b.name));
    return new Map(stable.map((b, i) => [b.branchId, branchColor(i)]));
  }, [data]);

  const branchOptions = useMemo(
    () =>
      data
        ? [...data.branches]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((b) => ({
              value: b.branchId,
              label: b.name,
              color: colorByBranch.get(b.branchId) ?? "var(--pc-primary)",
            }))
        : [],
    [data, colorByBranch],
  );

  // `data.branches` already arrives sorted desc by total (see API).
  const isExplicitSelection = selectedBranchIds.length > 0;
  const candidateBranches = data
    ? isExplicitSelection
      ? data.branches.filter((b) => selectedBranchIds.includes(b.branchId))
      : data.branches
    : [];
  const displayedBranches = isExplicitSelection
    ? candidateBranches
    : candidateBranches.slice(0, MAX_DEFAULT_BRANCHES);
  const hiddenCount = isExplicitSelection
    ? 0
    : Math.max(0, candidateBranches.length - MAX_DEFAULT_BRANCHES);

  const series: MultiSeries[] = displayedBranches.map((b) => ({
    id: b.branchId,
    label: b.name,
    color: colorByBranch.get(b.branchId) ?? "var(--pc-primary)",
    points: b.points,
  }));

  // Falls back to the top performer among the displayed branches whenever the
  // manual focus isn't (or is no longer) one of them — e.g. after narrowing
  // the compare selection to branches that don't include it.
  const effectiveFocusId =
    (focusedBranchId && displayedBranches.some((b) => b.branchId === focusedBranchId)
      ? focusedBranchId
      : displayedBranches[0]?.branchId) ?? null;
  const focusedBranch = data?.branches.find((b) => b.branchId === effectiveFocusId) ?? null;
  const focusedRank = focusedBranch
    ? data!.branches.findIndex((b) => b.branchId === focusedBranch.branchId) + 1
    : null;
  const focusedPctChange =
    focusedBranch && focusedBranch.previousTotal > 0
      ? ((focusedBranch.total - focusedBranch.previousTotal) / focusedBranch.previousTotal) * 100
      : null;

  return (
    <DashboardPanel
      title="Branch Sales Trend"
      subtitle={
        isExplicitSelection
          ? `Comparing ${selectedBranchIds.length} of ${data?.branches.length ?? 0} branches`
          : hiddenCount > 0
            ? `Showing top ${MAX_DEFAULT_BRANCHES} by revenue · +${hiddenCount} branches`
            : "All branches, one chart"
      }
      icon={<IconBarChart size={15} />}
      compact
      footerHref="/reports?category=sales&report=branch-sales"
      footerLabel="View branch sales →"
      headerRight={
        <>
          <BranchMultiSelect
            aria-label="Compare branches"
            options={branchOptions}
            selected={selectedBranchIds}
            onChange={setSelectedBranchIds}
          />
          <PeriodToggle
            aria-label="Branch sales trend period"
            value={period}
            options={PERIOD_OPTIONS}
            onChange={(v) => setPeriod(v as Period)}
          />
        </>
      }
      footerMeta={
        focusedBranch ? (
          <span className={css.footfallFooterMeta}>
            <span className={css.footfallPeakPill}>
              <IconActivity size={11} strokeWidth={2.5} aria-hidden />
              {focusedBranch.name}
            </span>
            <span className={css.muted}>LKR {formatCompactAxis(focusedBranch.total)}</span>
            {focusedPctChange != null ? (
              <span className={css.muted}>
                {focusedPctChange >= 0 ? "↑" : "↓"} {Math.abs(focusedPctChange).toFixed(1)}% vs previous{" "}
                {period} days
              </span>
            ) : null}
            {focusedRank != null ? (
              <span className={css.muted}>
                #{focusedRank} of {data!.branches.length} branches
              </span>
            ) : null}
          </span>
        ) : undefined
      }
    >
      {loading && !data ? (
        <p className={css.emptyState}>Loading branch trend…</p>
      ) : !data || data.branches.length === 0 ? (
        <p className={css.emptyState}>No branch sales data yet.</p>
      ) : displayedBranches.length === 0 ? (
        <p className={css.emptyState}>No branches selected — choose branches to compare.</p>
      ) : (
        <MultiLineChart
          series={series}
          height={160}
          formatValue={(n) => formatMoney(n)}
          showYAxis
          focusId={effectiveFocusId}
          onFocusChange={setFocusedBranchId}
          hiddenCount={hiddenCount}
        />
      )}
    </DashboardPanel>
  );
}
