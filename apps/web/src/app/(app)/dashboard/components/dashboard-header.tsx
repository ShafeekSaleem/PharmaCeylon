"use client";

import { IconRefresh } from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { formatRelativeTime } from "@/app/(app)/inventory/utils";
import type { DashboardRole } from "../lib/dashboard-role";
import { DASHBOARD_GREETINGS, formatRoleLabel } from "../lib/dashboard-role";
import type { OwnerAnalyticsScope } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

type Props = {
  role: DashboardRole;
  branchLabel?: string | null;
  branchHint?: string;
  /** Owner overview scope control (All branches / This branch). */
  ownerScope?: OwnerAnalyticsScope;
  onOwnerScopeChange?: (scope: OwnerAnalyticsScope) => void;
  loading?: boolean;
  lastUpdatedAt?: string | null;
  onRefresh?: () => void;
};

export function DashboardHeader({
  role,
  branchLabel,
  branchHint,
  ownerScope,
  onOwnerScopeChange,
  loading,
  lastUpdatedAt,
  onRefresh,
}: Props) {
  const greeting = DASHBOARD_GREETINGS[role];
  const showOwnerScope = role === "owner" && ownerScope && onOwnerScopeChange;

  return (
    <PageHeader
      subtitleOnly
      description={greeting}
      className={css.pageHeader}
      actions={
        <div className={css.headerControls}>
          {onRefresh ? (
            <span className={css.refreshStatus}>
              <span
                className={`${css.refreshDot} ${loading ? css.refreshDotBusy : ""}`}
                aria-hidden
              />
              {loading ? "Updating…" : lastUpdatedAt ? `Updated ${formatRelativeTime(lastUpdatedAt)}` : null}
              <button
                type="button"
                className={css.refreshBtn}
                onClick={onRefresh}
                disabled={loading}
                aria-label="Refresh dashboard data"
              >
                <IconRefresh size={13} strokeWidth={2} aria-hidden />
                Refresh
              </button>
            </span>
          ) : null}
          <span className={css.roleBadge}>Role: {formatRoleLabel(role)}</span>
          {showOwnerScope ? (
            <div
              className={css.scopeToggle}
              role="group"
              aria-label="Overview scope"
              data-tooltip={
                ownerScope === "this_branch"
                  ? (branchHint ??
                    (branchLabel
                      ? `Current branch: ${branchLabel}`
                      : "Current branch"))
                  : (branchHint ?? "Metrics across all branches")
              }
            >
              <button
                type="button"
                className={`${css.scopeToggleBtn} ${
                  ownerScope === "all_branches" ? css.scopeToggleBtnActive : ""
                }`}
                aria-pressed={ownerScope === "all_branches"}
                data-tooltip="Show metrics across all branches"
                onClick={() => onOwnerScopeChange("all_branches")}
              >
                All
              </button>
              <button
                type="button"
                className={`${css.scopeToggleBtn} ${
                  ownerScope === "this_branch" ? css.scopeToggleBtnActive : ""
                }`}
                aria-pressed={ownerScope === "this_branch"}
                data-tooltip={
                  branchLabel
                    ? `Show metrics for ${branchLabel}`
                    : "Show metrics for the current branch"
                }
                onClick={() => onOwnerScopeChange("this_branch")}
              >
                Current
              </button>
            </div>
          ) : branchLabel ? (
            <span
              className={css.branchChip}
              data-tooltip={
                branchHint ?? "Active branch — switch in the app header"
              }
            >
              <span className={css.branchDot} aria-hidden />
              {branchLabel}
              <span className={css.branchChevron} aria-hidden>
                ▾
              </span>
            </span>
          ) : null}
        </div>
      }
    />
  );
}
