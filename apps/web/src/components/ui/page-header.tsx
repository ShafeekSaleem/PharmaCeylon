import type { ReactNode } from "react";
import styles from "./page-header.module.css";

type Props = {
  title?: string;
  description?: string;
  /** When true, only the description is shown (shell already displays the page title). */
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
  const hasActions = Boolean(actions);
  return (
    <div
      className={`${styles.header}${
        floatingActions && hasActions ? ` ${styles.floatingActions}` : ""
      }${className ? ` ${className}` : ""}`}
    >
      <div className={styles.left}>
        {!subtitleOnly && title ? <h1 className={styles.title}>{title}</h1> : null}
        {description ? (
          <p className={subtitleOnly ? styles.subtitleLead : styles.description}>{description}</p>
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
