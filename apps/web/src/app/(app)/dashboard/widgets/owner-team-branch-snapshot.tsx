"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconEdit,
  IconUserPlus,
  IconUsers,
} from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { ProgressBar } from "../components/progress-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { branchTrackStatus, monthPaceExpectedPct } from "../lib/branch-status";
import css from "../dashboard.module.css";

export function OwnerTeamBranchSnapshotWidget({ data }: { data: DashboardData }) {
  const { loading, scopedBranchPerformance, branchPerformance, branchPerfYearMonth } = data;
  const yearMonth =
    branchPerfYearMonth ??
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const teamRows = scopedBranchPerformance ?? branchPerformance;
  const expectedPace = monthPaceExpectedPct();

  const teamStats = useMemo(() => {
    let onTrack = 0;
    let below = 0;
    let followUp = 0;
    let bestId: string | null = null;
    let bestPct = -1;
    // Tracks the single worst-performing branch needing follow-up so "Assign
    // support" can deep-link straight to its staff list instead of dropping
    // the owner on the unfiltered, contextless full staff directory.
    let neediestId: string | null = null;
    let neediestPct = Infinity;
    for (const row of teamRows) {
      const status = branchTrackStatus(row.achievementPct, expectedPace);
      if (status === "on_track") onTrack += 1;
      if (status === "at_risk" || status === "below") {
        below += 1;
        followUp += 1;
        const pct = row.achievementPct ?? -1;
        if (pct < neediestPct) {
          neediestPct = pct;
          neediestId = row.branchId;
        }
      }
      if (row.achievementPct != null && row.achievementPct > bestPct) {
        bestPct = row.achievementPct;
        bestId = row.branchId;
      }
    }
    return { branchCount: teamRows.length, onTrack, below, followUp, bestId, neediestId };
  }, [expectedPace, teamRows]);

  return (
    <DashboardPanel
      title="Team & Branch Snapshot"
        subtitle="This month's branch performance vs target"
        icon={<IconUsers size={15} />}
        compact
        headerRight={
          <Link href="/settings/branches#targets" className={css.teamSetTargetsBtn}>
            <IconEdit size={13} strokeWidth={1.75} aria-hidden />
            Set targets
          </Link>
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
                    {teamStats.followUp} branch{teamStats.followUp === 1 ? "" : "es"} need follow-up today
                  </span>
                ) : (
                  <span className={css.teamFollowUpOk}>All branches on pace</span>
                )}
                <Link
                  href={teamStats.neediestId ? `/users?branchId=${teamStats.neediestId}` : "/users"}
                  className={css.teamAssignBtn}
                >
                  <IconUserPlus size={13} strokeWidth={1.75} aria-hidden />
                  Assign support
                </Link>
              </div>
            </div>
          </div>
        )}
    </DashboardPanel>
  );
}
