"use client";

import Link from "next/link";
import { IconCheck } from "@/components/icons";
import css from "../dashboard.module.css";

export type TickerTone = "danger" | "warning" | "info";

export type TickerItem = {
  key: string;
  count: number | string;
  label: string;
  tone: TickerTone;
  href: string;
};

type Props = {
  items: TickerItem[];
  loading?: boolean;
  allClearText?: string;
};

/** Horizontal row of severity-colored pills — replaces a wall of low-signal stat cards. */
export function AttentionTicker({
  items,
  loading,
  allClearText = "Nothing needs attention right now",
}: Props) {
  if (loading) {
    return (
      <div className={css.tickerAllClear} role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={css.tickerAllClear}>
        <IconCheck size={13} strokeWidth={2.5} aria-hidden />
        {allClearText}
      </div>
    );
  }

  return (
    <nav className={css.ticker} aria-label="Items needing attention">
      {items.map((item) => (
        <Link key={item.key} href={item.href} className={css.tickerChip}>
          <span
            className={`${css.tickerDot} ${css[`tickerDot_${item.tone}`]}`}
            aria-hidden
          />
          <span className={css.tickerCount}>{item.count}</span>
          <span className={css.tickerLabel}>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
