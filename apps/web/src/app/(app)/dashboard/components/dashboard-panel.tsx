"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import css from "../dashboard.module.css";

type Props = {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  badge?: ReactNode;
  headerRight?: ReactNode;
  footerHref?: string;
  footerLabel?: string;
  footerMeta?: string;
  className?: string;
  children: ReactNode;
  compact?: boolean;
};

export function DashboardPanel({
  title,
  subtitle,
  icon,
  badge,
  headerRight,
  footerHref,
  footerLabel,
  footerMeta,
  className,
  children,
  compact,
}: Props) {
  const showFooter = Boolean((footerHref && footerLabel) || footerMeta);

  return (
    <section
      className={`${css.panel}${compact ? ` ${css.panelCompact}` : ""}${className ? ` ${className}` : ""}`}
    >
      <header className={css.panelHeader}>
        <div className={css.panelTitleBlock}>
          <h2 className={css.panelTitle}>
            {icon ? <span className={css.panelIcon}>{icon}</span> : null}
            {title}
          </h2>
          {subtitle ? <p className={css.panelSubtitle}>{subtitle}</p> : null}
        </div>
        <div className={css.panelHeaderRight}>
          {badge}
          {headerRight}
        </div>
      </header>
      <div className={css.panelBody}>{children}</div>
      {showFooter ? (
        <footer className={css.panelFooter}>
          {footerHref && footerLabel ? (
            <Link href={footerHref} className={css.panelFooterLink}>
              {footerLabel}
            </Link>
          ) : (
            <span />
          )}
          {footerMeta ? <span className={css.panelFooterMeta}>{footerMeta}</span> : null}
        </footer>
      ) : null}
    </section>
  );
}
