"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
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

/** Where the open menu sits, in viewport coordinates. */
type MenuPosition = { top?: number; bottom: number | undefined; right: number };

const GAP = 4;
const VIEWPORT_MARGIN = 8;
const ITEM_HEIGHT = 40;
const MAX_ESTIMATED_HEIGHT = 280;

/**
 * The overflow menu at the end of a dense row.
 *
 * Shared by Categories, Tags and the catalog Work Queue, which each independently grew a row of
 * four to six unlabeled icon buttons — two of them destructive, none of them distinguishable
 * without hovering. Collapsing the secondary ones behind a named menu costs a click and buys
 * back both the horizontal space and the certainty about what a button does.
 *
 * The menu itself is rendered in a portal at viewport coordinates rather than absolutely inside
 * the row. Every container it sits in clips: a category card rounds its corners with
 * `overflow: hidden`, and a `DataTable` scrolls horizontally — both of which cut an
 * absolutely-positioned menu off at the container edge, so on the last row of a table the menu
 * was simply invisible. React portals still propagate events through the component tree, so a
 * clickable row behind the menu behaves exactly as it did before.
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
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const needed = Math.min(
      actions.length * ITEM_HEIGHT + 16,
      MAX_ESTIMATED_HEIGHT,
    );
    const dropUp =
      rect.bottom + needed > window.innerHeight && rect.top > needed;
    // Offsets are measured against the initial containing block, which excludes the scrollbar —
    // `window.innerWidth` would include it and shift the menu under the scrollbar by ~15px.
    const viewportWidth = document.documentElement.clientWidth;
    setPosition({
      top: dropUp ? undefined : rect.bottom + GAP,
      bottom: dropUp ? window.innerHeight - rect.top + GAP : undefined,
      right: Math.max(VIEWPORT_MARGIN, viewportWidth - rect.right),
    });
  }, [actions.length]);

  // Measured before paint so the menu never appears in one place and then jumps to another.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      // The menu is portalled out of the row, so it is not inside `ref` any more — without
      // checking it too, mousedown on an item would close the menu before its click landed.
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function reposition() {
      place();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    // Capture, so scrolling any ancestor container keeps the menu attached to its trigger.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, place]);

  if (actions.length === 0) return null;

  const menu = open && position && (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      style={{
        top: position.top,
        bottom: position.bottom,
        right: position.right,
      }}
    >
      {actions.map((action) => (
        <div key={action.label}>
          {action.separated && (
            <div className={styles.separator} role="separator" />
          )}
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
  );

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
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
