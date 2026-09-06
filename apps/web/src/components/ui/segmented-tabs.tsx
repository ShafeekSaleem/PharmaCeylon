"use client";

import { useCallback, useRef, type ReactNode } from "react";
import styles from "./segmented-tabs.module.css";

export type SegmentedTabItem<T extends string> = {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number | null;
  /** Renders the count in the attention tone. Always paired with wording, never colour alone. */
  attention?: boolean;
  /** Appended to the accessible name, e.g. "24 needing review". */
  countLabel?: string;
};

type Props<T extends string> = {
  items: SegmentedTabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Names the tablist for screen readers. Required — an unlabelled tablist is a bare list. */
  ariaLabel: string;
  className?: string;
};

/**
 * A compact secondary tab bar for switching sections **within one page**.
 *
 * Real ARIA tabs, not links styled as tabs: the sections it switches between are rendered in
 * place, so `role="tab"` is accurate and the keyboard contract that comes with it is
 * implemented here rather than assumed — arrow keys move between tabs, Home/End jump to the
 * ends, and a roving tabindex keeps the whole bar a single tab stop.
 *
 * Anything that actually navigates should use links instead. Borrowing tab roles for
 * navigation is the common version of this mistake, and it leaves arrow keys dead.
 */
export function SegmentedTabs<T extends string>({
  items,
  active,
  onChange,
  ariaLabel,
  className,
}: Props<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number) => {
      const last = items.length - 1;
      let next: number | null = null;
      if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
      else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      if (next === null) return;

      event.preventDefault();
      // Automatic activation: these sections are already loaded, so following focus costs
      // nothing and matches how the rest of the app's tabs behave.
      onChange(items[next].id);
      refs.current[next]?.focus();
    },
    [items, onChange],
  );

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`${styles.bar}${className ? ` ${className}` : ""}`}
    >
      {items.map((item, index) => {
        const selected = item.id === active;
        const countText =
          item.count != null
            ? `, ${item.count.toLocaleString()}${item.countLabel ? ` ${item.countLabel}` : ""}`
            : "";
        return (
          <button
            key={item.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`segtab-${item.id}`}
            aria-selected={selected}
            aria-controls={`segpanel-${item.id}`}
            aria-label={`${item.label}${countText}`}
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab}${selected ? ` ${styles.tabActive}` : ""}`}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.count != null && (
              <span
                aria-hidden
                className={`${styles.count}${item.attention ? ` ${styles.countAttention}` : ""}`}
              >
                {item.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a `SegmentedTabs` tab controls. Keeps the id/labelling contract in one place. */
export function SegmentedTabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`segpanel-${id}`}
      aria-labelledby={`segtab-${id}`}
      hidden={!active}
      // Panels hold their own headings and controls, so the panel itself is not a tab stop.
      tabIndex={-1}
    >
      {active ? children : null}
    </div>
  );
}
