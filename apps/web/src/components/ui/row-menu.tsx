"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconMoreVertical } from "@/components/icons";
import styles from "./row-menu.module.css";

export type RowMenuAction = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Shown under the label — used to say why an action won't do what you'd expect. */
  hint?: string;
  /** Draws a divider above this item. For separating destructive actions from routine ones. */
  separated?: boolean;
};

/**
 * The overflow menu at the end of a dense row.
 *
 * Shared by Categories, Tags and the catalog Work Queue, which each independently grew a row of
 * four to six unlabeled icon buttons — two of them destructive, none of them distinguishable
 * without hovering. Collapsing the secondary ones behind a named menu costs a click and buys
 * back both the horizontal space and the certainty about what a button does.
 *
 * Flips above the trigger when there isn't room below, so the last row of a long table doesn't
 * open a menu into the fold.
 */
export function RowMenu({
  label,
  actions,
  icon,
}: {
  /** Names the trigger for screen readers: "Actions for Pain & Fever". */
  label: string;
  actions: RowMenuAction[];
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Measured before paint so the menu never appears below and then jumps above.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const needed = Math.min(actions.length * 40 + 16, 280);
    setDropUp(rect.bottom + needed > window.innerHeight && rect.top > needed);
  }, [open, actions.length]);

  if (actions.length === 0) return null;

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={`${styles.trigger}${open ? ` ${styles.triggerOpen}` : ""}`}
        onClick={(e) => {
          // Rows are often clickable themselves; opening the menu must not also open the row.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon ?? <IconMoreVertical size={15} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          className={`${styles.menu}${dropUp ? ` ${styles.menuUp}` : ""}`}
          role="menu"
        >
          {actions.map((action) => (
            <div key={action.label}>
              {action.separated && <div className={styles.separator} role="separator" />}
              <button
                type="button"
                role="menuitem"
                disabled={action.disabled}
                className={`${styles.item}${action.danger ? ` ${styles.itemDanger}` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick();
                  setOpen(false);
                }}
              >
                {action.label}
                {action.hint && <span className={styles.hint}>{action.hint}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
