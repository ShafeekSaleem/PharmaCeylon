"use client";

import { useMemo } from "react";
import { IconAlertTriangle, IconCalendar, IconChevronDown, IconChevronUp, IconUsers } from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { ProgressBar } from "../components/progress-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { branchTrackStatus, formatYearMonth, monthPaceExpectedPct } from "../lib/branch-status";
import css from "../dashboard.module.css";

export function ManagerBranchSalesVsTargetWidget({ data }: { data: DashboardData }) {
  const { assignedBranchTargets, currentBranchPerf, branchPerfYearMonth } = data;
  const targetRows = useMemo(
    () =>
      assignedBranchTargets.length > 0
        ? assignedBranchTargets
        : currentBranchPerf
          ? [currentBranchPerf]
          : [],
    [assignedBranchTargets, currentBranchPerf],
  );
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
    <DashboardPanel
      title="Branch Sales vs Target"
      icon={<IconUsers size={15} />}
      footerHref="/reports?category=sales&report=branch-sales"
      footerLabel="View branch sales →"
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
          No monthly target assigned yet. Owners set branch targets and assign a manager for performance.
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
                          {status === "on_track" ? "On track" : status === "at_risk" ? "At risk" : "Below target"}
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
  );
}
