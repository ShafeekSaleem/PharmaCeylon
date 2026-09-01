"use client";

import { useMemo } from "react";
import { IconUsers } from "@/components/icons";
import { DashboardPanel } from "../components/dashboard-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { branchColor } from "../lib/branch-colors";
import { formatYearMonth } from "../lib/branch-status";
import css from "../dashboard.module.css";

export function OwnerBranchRevenueContributionWidget({ data }: { data: DashboardData }) {
  const { scopedBranchPerformance, branchPerformance, branchPerfYearMonth } = data;
  const teamRows = scopedBranchPerformance ?? branchPerformance;
  const yearMonth =
    branchPerfYearMonth ??
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

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

  return (
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
  );
}
