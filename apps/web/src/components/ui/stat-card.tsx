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
}: Props) {
  const cardCls = [
    styles.card,
    onClick ? styles.clickable : "",
    active ? styles.active : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const iconCls = [styles.icon, styles[`icon_${iconTone}`]].join(" ");

  const inner = (
    <>
      <div className={styles.top}>
        <span className={styles.title}>{title}</span>
        {icon && <span className={iconCls}>{icon}</span>}
      </div>
      <div className={styles.value}>{value}</div>
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
};

export function StatGrid({ children, columns = 4, className }: GridProps) {
  return (
    <div
      className={`${styles.grid}${className ? ` ${className}` : ""}`}
      style={{ "--stat-cols": columns } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
