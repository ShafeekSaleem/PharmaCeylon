import type { ReactNode } from "react";
import styles from "./stat-card.module.css";

export type StatIconTone = "primary" | "success" | "warning" | "danger" | "info";

type Props = {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  iconTone?: StatIconTone;
  trend?: { value: string; positive?: boolean };
  className?: string;
  onClick?: () => void;
  active?: boolean;
  /** Compact density for list dashboards. */
  size?: "md" | "sm";
};

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  iconTone = "primary",
  trend,
  className,
  onClick,
  active = false,
  size = "md",
}: Props) {
  const cardCls = [
    styles.card,
    size === "sm" ? styles.cardSm : "",
    onClick ? styles.clickable : "",
    active ? styles.active : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const iconCls = [
    styles.icon,
    size === "sm" ? styles.iconSm : "",
    styles[`icon_${iconTone}`],
  ].join(" ");

  const inner = (
    <>
      <div className={styles.top}>
        <span className={styles.title}>{title}</span>
        {icon && <span className={iconCls}>{icon}</span>}
      </div>
      <div className={size === "sm" ? styles.valueSm : styles.value}>{value}</div>
      {(subtitle || trend) && (
        <div className={styles.bottom}>
          {trend && (
            <span className={trend.positive ? styles.trendUp : styles.trendDown}>
              {trend.positive ? "↑" : "↓"} {trend.value}
            </span>
          )}
          {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        </div>
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={cardCls} onClick={onClick}>
        {inner}
      </button>
    );
  }

  return <div className={cardCls}>{inner}</div>;
}

type GridProps = {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
  dense?: boolean;
};

export function StatGrid({ children, columns = 4, className, dense = false }: GridProps) {
  return (
    <div
      className={`${styles.grid}${dense ? ` ${styles.gridSm}` : ""}${className ? ` ${className}` : ""}`}
      style={{ "--stat-cols": columns } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
