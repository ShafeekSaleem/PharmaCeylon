"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconChevronUp, IconMoreVertical } from "@/components/icons";
import styles from "./stat-card.module.css";

export type StatIconTone = "primary" | "success" | "warning" | "danger" | "info";
export type StatTrendDirection = "up" | "down" | "flat";
export type StatTrendTone = "positive" | "warning" | "danger" | "neutral";

export type StatTrend = {
  value: string;
  /** Legacy: true → up/positive, false → down/danger (overridden by direction/tone). */
  positive?: boolean;
  direction?: StatTrendDirection;
  tone?: StatTrendTone;
};

export type StatMenuItem = {
  label: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
};

type Props = {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  iconTone?: StatIconTone;
  trend?: StatTrend;
  className?: string;
  onClick?: () => void;
  active?: boolean;
  /** Compact density for list dashboards. */
  size?: "md" | "sm";
  /**
   * Show the ⋮ control. Defaults to true when `menuItems` are provided,
   * otherwise false when the whole card is clickable (filter tiles).
   */
  showMenu?: boolean;
  /** Functional dropdown actions. Prefer real navigation links. */
  menuItems?: StatMenuItem[];
  /** @deprecated Prefer `menuItems`. Still called when the menu opens if provided. */
  onMenuClick?: () => void;
};

function resolveTrend(trend: StatTrend): {
  direction: StatTrendDirection;
  tone: StatTrendTone;
} {
  const direction =
    trend.direction ?? (trend.positive === false ? "down" : "up");
  const tone =
    trend.tone ?? (trend.positive === false ? "danger" : "positive");
  return { direction, tone };
}

/** Keep mockup style: arrow + raw value (no forced + prefix). */
function formatTrendValue(value: string): string {
  return value.trim();
}

function defaultMenuItems(value: string | number): StatMenuItem[] {
  return [
    {
      label: "Copy value",
      onClick: () => {
        void navigator.clipboard?.writeText(String(value));
      },
    },
  ];
}

function StatCardMenu({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: StatMenuItem[];
  onOpen?: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const close = useCallback(() => setOpen(false), []);

  const updatePosition = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menuWidth = 188;
    const gap = 4;
    let left = rect.right - menuWidth;
    left = Math.min(Math.max(8, left), window.innerWidth - menuWidth - 8);
    let top = rect.bottom + gap;
    const estimatedHeight = 8 + items.length * 36;
    if (top + estimatedHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - estimatedHeight - gap);
    }
    setPos({ top, left });
  }, [items.length]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        btnRef.current?.focus();
      }
    };

    const onPointer = (e: MouseEvent | PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };

    const onReposition = () => updatePosition();

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, close, updatePosition]);

  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!open) {
      onOpen?.();
      updatePosition();
      setOpen(true);
    } else {
      close();
    }
  };

  const runItem = (item: StatMenuItem) => {
    if (item.disabled) return;
    item.onClick?.();
    close();
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.menuBtn}
        aria-label={`${title} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
      >
        <IconMoreVertical size={14} />
      </button>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={`${title} options`}
              className={styles.menu}
              style={{ top: pos.top, left: pos.left }}
            >
              {items.map((item) => {
                const cls = [
                  styles.menuItem,
                  item.disabled ? styles.menuItemDisabled : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                if (item.href && !item.disabled) {
                  return (
                    <Link
                      key={item.label}
                      href={item.href}
                      role="menuitem"
                      className={cls}
                      onClick={(e) => {
                        e.stopPropagation();
                        item.onClick?.();
                        close();
                      }}
                    >
                      {item.label}
                    </Link>
                  );
                }

                return (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={cls}
                    disabled={item.disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      runItem(item);
                    }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

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
  showMenu,
  menuItems,
  onMenuClick,
}: Props) {
  const resolvedItems =
    menuItems && menuItems.length > 0
      ? menuItems
      : !onClick
        ? defaultMenuItems(value)
        : [];

  const menuVisible =
    showMenu ?? (resolvedItems.length > 0 && (!onClick || Boolean(menuItems?.length)));

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

  const resolved = trend ? resolveTrend(trend) : null;
  const trendCls = resolved
    ? [styles.trend, styles[`trend_${resolved.tone}`]].join(" ")
    : "";

  const TrendArrow =
    resolved?.direction === "down"
      ? IconChevronDown
      : resolved?.direction === "up"
        ? IconChevronUp
        : null;

  const menu =
    menuVisible && resolvedItems.length > 0 ? (
      <StatCardMenu title={title} items={resolvedItems} onOpen={onMenuClick} />
    ) : null;

  const inner = (
    <>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          {icon ? <span className={iconCls}>{icon}</span> : null}
          <span className={styles.title}>{title}</span>
        </div>
        {menu}
      </div>
      <div className={size === "sm" ? styles.valueSm : styles.value}>{value}</div>
      {(subtitle || trend) && (
        <div className={styles.metaRow}>
          {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : <span />}
          {trend && resolved ? (
            <span className={trendCls}>
              {TrendArrow ? <TrendArrow size={11} strokeWidth={2.5} /> : null}
              {formatTrendValue(trend.value)}
            </span>
          ) : null}
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
  columns?: 2 | 3 | 4 | 5 | 6;
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
