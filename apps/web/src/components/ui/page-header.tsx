"use client";

import type { ReactNode } from "react";
import { usePageTitle } from "@/components/app-shell/page-title-context";
import styles from "./page-header.module.css";

type Props = {
  title?: string;
  description?: string;
  /**
   * Use the shell's name for this page (from the route, or a page's `setLastSegmentLabel`)
   * instead of passing `title`. The page header is the one place a page's title appears (#205).
   */
  subtitleOnly?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Position actions over the header so they do not change its height. */
  floatingActions?: boolean;
};

export function PageHeader({
  title,
  description,
  subtitleOnly = false,
  actions,
  children,
  className,
  floatingActions = false,
}: Props) {
  const shellTitle = usePageTitle();
  const hasActions = Boolean(actions);
  const heading = subtitleOnly ? (shellTitle ?? undefined) : title;
  return (
    <div
      className={`${styles.header}${
        floatingActions && hasActions ? ` ${styles.floatingActions}` : ""
      }${className ? ` ${className}` : ""}`}
    >
      <div className={styles.left}>
        {heading ? <h1 className={styles.title}>{heading}</h1> : null}
        {description ? (
          <p className={heading ? styles.description : styles.subtitleLead}>{description}</p>
        ) : null}
      </div>
      {hasActions && <div className={styles.actions}>{actions}</div>}
      {children}
    </div>
  );
}

/* Reusable action button to pair with PageHeader */

type ActionBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  icon?: ReactNode;
  /** Shown via FloatingTooltipHost (`data-tooltip`). */
  tooltip?: string;
};

export function ActionButton({
  variant = "primary",
  icon,
  children,
  className,
  tooltip,
  ...rest
}: ActionBtnProps) {
  const cls = [
    styles.actionBtn,
    variant === "primary"
      ? styles.actionPrimary
      : variant === "danger"
        ? styles.actionDanger
        : styles.actionSecondary,
    className ?? "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className={cls}
      {...rest}
      {...(tooltip ? { "data-tooltip": tooltip } : null)}
    >
      {icon && <span className={styles.actionIcon}>{icon}</span>}
      {children}
    </button>
  );
}
