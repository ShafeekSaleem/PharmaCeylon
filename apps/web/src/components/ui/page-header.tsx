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
};

export function PageHeader({
  title,
  description,
  subtitleOnly = false,
  actions,
  children,
  className,
}: Props) {
  return (
    <div className={`${styles.header}${className ? ` ${className}` : ""}`}>
      <div className={styles.left}>
        {!subtitleOnly && title ? <h1 className={styles.title}>{title}</h1> : null}
        {description ? (
          <p className={subtitleOnly ? styles.subtitleLead : styles.description}>{description}</p>
        ) : null}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
      {children}
    </div>
  );
}

/* Reusable action button to pair with PageHeader */

type ActionBtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  icon?: ReactNode;
};

export function ActionButton({
  variant = "primary",
  icon,
  children,
  className,
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
    <button type="button" className={cls} {...rest}>
      {icon && <span className={styles.actionIcon}>{icon}</span>}
      {children}
    </button>
  );
}
