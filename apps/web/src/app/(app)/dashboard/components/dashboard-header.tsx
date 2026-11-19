"use client";

import { useEffect, useState } from "react";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";
import {
  IconCheck,
  IconPlus,
  IconRefresh,
  IconRotateCcw,
  IconX,
} from "@/components/icons";
import { PageHeader } from "@/components/ui";
import { formatRelativeTime } from "@/app/(app)/inventory/utils";
import type { DashboardRole } from "../lib/dashboard-role";
import { formatRoleLabel } from "../lib/dashboard-role";
import type { QuickAction } from "./quick-actions-bar";
import { DashboardShortcutsMenu } from "./dashboard-shortcuts-menu";
import css from "../dashboard.module.css";

type CustomizeProps = {
  isEditing: boolean;
  onToggleEdit: () => void;
  onOpenAddWidget: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onResetToDefault: () => void;
  isDirty: boolean;
  saving: boolean;
};

type Props = {
  role: DashboardRole;
  /** The top-bar branch every card on the page follows. */
  branchLabel?: string | null;
  /** The branch's timezone, so "today" in the title is the pharmacy's day. */
  timeZone?: string;
  loading?: boolean;
  lastUpdatedAt?: string | null;
  onRefresh?: () => void;
  shortcuts?: QuickAction[];
  customize?: CustomizeProps;
};

/** "Thursday, 19 November": the page is about today, so the date is its title (UI1 #205). */
export function dashboardDateTitle(now: Date, timeZone?: string): string {
  return now.toLocaleDateString(DISPLAY_LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * The dashboard's header: the date as the title, the branch and role under it, and two controls,
 * Refresh and Customise. The branch is chosen once, in the top bar, so nothing here can disagree
 * with it.
 */
export function DashboardHeader({
  role,
  branchLabel,
  timeZone,
  loading,
  lastUpdatedAt,
  onRefresh,
  shortcuts,
  customize,
}: Props) {
  // `formatRelativeTime` reads Date.now() at render time, so without something to force a
  // re-render the "Updated Xm ago" text just freezes at whatever it said on the last actual
  // data refresh — a dashboard left open for ten minutes would still read "Just now".
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!lastUpdatedAt) return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [lastUpdatedAt]);

  const updated = loading
    ? "Updating…"
    : lastUpdatedAt
      ? `Updated ${formatRelativeTime(lastUpdatedAt).toLowerCase()}`
      : null;
  const description = [branchLabel, `${formatRoleLabel(role)} view`, updated]
    .filter(Boolean)
    .join(" · ");

  return (
    <PageHeader
      title={dashboardDateTitle(new Date(), timeZone)}
      description={description}
      className={css.pageHeader}
      actions={
        <div className={css.headerControls}>
          {onRefresh ? (
            <button
              type="button"
              className={css.headerQuietBtn}
              onClick={onRefresh}
              disabled={loading}
            >
              <IconRefresh size={14} strokeWidth={2} aria-hidden />
              Refresh
            </button>
          ) : null}
          {shortcuts?.length ? (
            <DashboardShortcutsMenu actions={shortcuts} />
          ) : null}
          {customize ? (
            customize.isEditing ? (
              <div className={css.customizeBar}>
                <button
                  type="button"
                  className={css.customizeBtn}
                  onClick={customize.onOpenAddWidget}
                >
                  <IconPlus size={13} strokeWidth={1.75} aria-hidden />
                  Add widget
                </button>
                <button
                  type="button"
                  className={css.customizeBtn}
                  onClick={customize.onResetToDefault}
                >
                  <IconRotateCcw size={13} strokeWidth={1.75} aria-hidden />
                  Reset
                </button>
                <button
                  type="button"
                  className={css.customizeBtn}
                  onClick={customize.onDiscard}
                >
                  <IconX size={13} strokeWidth={2} aria-hidden />
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${css.customizeBtn} ${css.customizeBtnPrimary}`}
                  onClick={customize.onSave}
                  disabled={!customize.isDirty || customize.saving}
                >
                  <IconCheck size={13} strokeWidth={2} aria-hidden />
                  {customize.saving ? "Saving…" : "Save"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={css.customizeBtn}
                onClick={customize.onToggleEdit}
              >
                Customise
              </button>
            )
          ) : null}
        </div>
      }
    />
  );
}
