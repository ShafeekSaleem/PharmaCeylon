"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import css from "../dashboard.module.css";

export type DashboardAlert = {
  key: string;
  label: string;
  /** Optional supporting line under the title (ChatGPT-style alert rows). */
  detail?: string;
  count?: number;
  tone: "danger" | "warning" | "info" | "success";
  href?: string;
  actionLabel?: string;
  icon?: ReactNode;
};

type Props = {
  alerts: DashboardAlert[];
  emptyText?: string;
  /** Show a trailing action affordance (mockup “View” buttons). */
  showAction?: boolean;
};

const TONE_CLASS: Record<DashboardAlert["tone"], string> = {
  danger: css.alertItemDanger,
  warning: css.alertItemWarning,
  info: css.alertItemInfo,
  success: css.alertItemSuccess,
};

const ICON_TONE: Record<DashboardAlert["tone"], string> = {
  danger: css.alertIcon_danger,
  warning: css.alertIcon_warning,
  info: css.alertIcon_info,
  success: css.alertIcon_success,
};

export function AlertList({
  alerts,
  emptyText = "No active alerts.",
  showAction = false,
}: Props) {
  if (alerts.length === 0) {
    return <p className={css.emptyState}>{emptyText}</p>;
  }

  return (
    <ul className={css.alertList}>
      {alerts.map((alert) => {
        const cls = `${css.alertItem} ${TONE_CLASS[alert.tone]}`;
        const body = (
          <>
            <span className={css.alertLead}>
              {alert.icon ? (
                <span className={`${css.alertIcon} ${ICON_TONE[alert.tone]}`} aria-hidden>
                  {alert.icon}
                </span>
              ) : (
                <span
                  className={`${css.alertToneDot} ${css[`alertDot_${alert.tone}`]}`}
                  aria-hidden
                />
              )}
              <span className={css.alertText}>
                <span className={css.alertTitle}>{alert.label}</span>
                {alert.detail ? (
                  <span className={css.alertDetail}>{alert.detail}</span>
                ) : null}
              </span>
            </span>
            <span className={css.alertTrailing}>
              {alert.count != null ? (
                <span className={css.alertCount}>{alert.count}</span>
              ) : null}
              {showAction && alert.href ? (
                <span className={css.alertAction}>{alert.actionLabel ?? "View"}</span>
              ) : null}
            </span>
          </>
        );
        return (
          <li key={alert.key}>
            {alert.href ? (
              <Link href={alert.href} className={cls}>
                {body}
              </Link>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
