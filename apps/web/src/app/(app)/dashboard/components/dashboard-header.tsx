"use client";

import { IconGrid, IconSettings } from "@/components/icons";
import { PageHeader } from "@/components/ui";
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
};

export function DashboardHeader({
  role,
  branchLabel,
  branchHint,
  ownerScope,
  onOwnerScopeChange,
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
          <button
            type="button"
            className={css.customizeBtn}
            disabled
            title="Dashboard customization coming soon"
            aria-label="Customize dashboard (coming soon)"
          >
            <IconSettings size={14} aria-hidden />
            Customize dashboard
          </button>
          <button
            type="button"
            className={css.layoutToggle}
            disabled
            title="Layout options coming soon"
            aria-label="Layout options (coming soon)"
          >
            <IconGrid size={15} aria-hidden />
          </button>
        </div>
      }
    />
  );
}
