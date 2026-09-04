"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import css from "../categories.module.css";

export type CategoryRowAction = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** Shown under the label — used to say why an action won't do what you'd expect. */
  hint?: string;
};

/**
 * The overflow menu for a category row.
 *
 * Rename, add-subcategory, move-products and delete used to be four unlabeled icons sitting
 * next to two more for reorder — six in a row, with nothing distinguishing the destructive
 * ones. Naming them costs one click and removes the guessing.
 */
export function CategoryRowMenu({
  label,
  icon,
  actions,
}: {
  label: string;
  icon: ReactNode;
  actions: CategoryRowAction[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  if (actions.length === 0) return null;

  return (
    <div className={css.menuWrap} ref={ref}>
      <button
        type="button"
        className={css.iconBtn}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon}
      </button>
      {open && (
        <div className={css.menu} role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={a.danger ? css.menuItemDanger : undefined}
              onClick={() => {
                a.onClick();
                setOpen(false);
              }}
            >
              {a.label}
              {a.hint && <span className={css.menuItemHint}>{a.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
