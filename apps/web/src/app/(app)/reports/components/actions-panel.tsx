"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { IconChevronLeft, IconChevronRight } from "@/components/icons";
import css from "../reports.module.css";

export type ActionExample = { label: string; badge?: string; tone?: "positive" | "negative" | "neutral"; href?: string };

export type ActionPanelItem = {
  key: string;
  icon: ReactNode;
  tone: "primary" | "warning" | "danger" | "purple" | "muted";
  title: string;
  description: string;
  /** `count`/`countLabel` are optional — omit both for an insight with no natural number to
   *  show; the badge then renders as a plain chevron affordance instead of `{count} {countLabel}`. */
  count?: number;
  countLabel?: string;
  /** Overrides the `{count} {countLabel}` chip with a literal pre-formatted string (e.g. a money
   *  value like "LKR 212,450"). */
  countText?: string;
  /** Up to a few concrete examples shown as chips under the row — only used in `variant="cards"`. */
  examples?: ActionExample[];
  onClick?: () => void;
  /** When set (with `onClick`), replaces the numeric count on the right of a `variant="rows"` item
   * with a colored text CTA button instead — e.g. "View target gaps" — for alert-style action lists. */
  ctaLabel?: string;
};

type Props = {
  title: string;
  items: ActionPanelItem[];
  onViewAll?: () => void;
  primaryAction?: { label: string; icon: ReactNode; onClick: () => void };
  /** "rows" (default) is the flat divided-row list; "cards" is a bordered box per item with a
   * colored count pill and example chips underneath. */
  variant?: "rows" | "cards";
  /** Items beyond this many are paginated instead of all rendered at once, so a long insight list
   * doesn't grow the card past its siblings. Defaults to 4 — set a higher number to opt out in
   * practice for panels that are always short. */
  pageSize?: number;
  /** Customizes the "View all insights" footer button text — e.g. "Open purchasing →" when it
   * navigates somewhere more specific than a generic insights list. */
  viewAllLabel?: string;
  /** Extra header-right content shown alongside (or instead of) the "View all" button — e.g. a
   *  "Sample" badge plus a "Not connected" note for a not-yet-wired preview panel. */
  headerExtra?: ReactNode;
};

export function ActionsPanel({
  title,
  items,
  onViewAll,
  primaryAction,
  variant = "rows",
  pageSize = 4,
  viewAllLabel = "View all insights",
  headerExtra,
}: Props) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [items.length]);

  const pageItems = items.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  return (
    <div className={css.card}>
      <div className={css.cardhead}>
        <div>
          <h3>{title}</h3>
        </div>
        {headerExtra}
        {onViewAll ? (
          <button type="button" className={css.cardLink} onClick={onViewAll}>
            {viewAllLabel} <IconChevronRight size={13} />
          </button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className={css.emptyNote}>Nothing needs attention right now.</p>
      ) : variant === "cards" ? (
        <div className={css.insightCardList}>
          {pageItems.map((item) => (
            <div key={item.key} className={css.insightCardBox}>
              <button type="button" className={css.insightCardTop} onClick={item.onClick} disabled={!item.onClick}>
                <span className={`${css.actionIconSq} ${css[item.tone]}`}>{item.icon}</span>
                <span className={css.actionBody}>
                  <span className={css.actionTitle}>{item.title}</span>
                  <br />
                  <span className={css.actionDesc}>{item.description}</span>
                </span>
                <span className={`${css.insightCountPill} ${css[item.tone]}`}>
                  {item.countText ?? (item.count != null && item.countLabel ? `${item.count} ${item.countLabel}` : null)}
                  <IconChevronRight size={12} />
                </span>
              </button>
              {item.examples && item.examples.length > 0 ? (
                <div className={css.chipRow2}>
                  {item.examples.map((ex, i) => {
                    const inner = (
                      <>
                        <span className={css.chip2Label}>{ex.label}</span>
                        {ex.badge ? <b className={ex.tone === "negative" ? css.deltaDown : ex.tone === "neutral" ? css.chip2Neutral : css.deltaUp}>{ex.badge}</b> : null}
                      </>
                    );
                    return ex.href ? (
                      <Link key={i} href={ex.href} className={`${css.chip2} ${css.chip2Link}`} data-tooltip={ex.label}>
                        {inner}
                      </Link>
                    ) : (
                      <span key={i} className={css.chip2} data-tooltip={ex.label}>
                        {inner}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className={css.actionsPanel}>
          {pageItems.map((item) => (
            <button key={item.key} type="button" className={css.actionRow} onClick={item.onClick} disabled={!item.onClick}>
              <span className={`${css.actionIconSq} ${css[item.tone]}`}>{item.icon}</span>
              <span className={css.actionBody}>
                <span className={css.actionTitle}>{item.title}</span>
                <br />
                <span className={css.actionDesc}>{item.description}</span>
              </span>
              {item.ctaLabel ? (
                <span className={`${css.actionCta} ${css[item.tone]}`}>
                  {item.ctaLabel}
                  <IconChevronRight size={13} />
                </span>
              ) : item.countText ? (
                <span className={css.actionCount}>{item.countText}</span>
              ) : item.count != null ? (
                <span className={css.actionCount}>
                  {item.count}
                  <small>{item.countLabel}</small>
                </span>
              ) : (
                <IconChevronRight size={13} />
              )}
            </button>
          ))}
        </div>
      )}

      {totalPages > 1 ? (
        <div className={css.insightPagination}>
          <button type="button" className={css.insightPageBtn} disabled={clampedPage <= 1} onClick={() => setPage(clampedPage - 1)} aria-label="Previous insights">
            <IconChevronLeft size={14} />
          </button>
          <span className={css.insightPageInfo}>
            {clampedPage} / {totalPages}
          </span>
          <button type="button" className={css.insightPageBtn} disabled={clampedPage >= totalPages} onClick={() => setPage(clampedPage + 1)} aria-label="Next insights">
            <IconChevronRight size={14} />
          </button>
        </div>
      ) : null}

      {primaryAction ? (
        <button type="button" className={css.primaryActionBtn} onClick={primaryAction.onClick}>
          {primaryAction.icon}
          {primaryAction.label}
        </button>
      ) : null}
    </div>
  );
}
