"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconFilter, IconTrash } from "@/components/icons";
import css from "./filter-popover.module.css";

type FilterPopoverProps = {
  /** Whether any filter inside the panel is currently applied — highlights the trigger
   *  and shows the small active-dot badge. */
  active: boolean;
  triggerLabel?: string;
  panelTitle?: string;
  panelAriaLabel: string;
  children: ReactNode;
};

/**
 * "Filter" trigger button + click-outside popover panel — the shell used by the Products
 * and Inventory filter panels (and any future one). Compose it with `FilterRow` for each
 * individual filter control inside.
 */
export function FilterPopover({
  active,
  triggerLabel = "Filter",
  panelTitle = "Filter",
  panelAriaLabel,
  children,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={css.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${css.filterBtn} ${active ? css.filterBtnActive : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <IconFilter size={15} />
        {triggerLabel}
        <span
          className={`${css.filterBadge} ${active ? css.filterBadgeVisible : ""}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className={css.panel} role="dialog" aria-label={panelAriaLabel}>
          <h3 className={css.panelTitle}>{panelTitle}</h3>
          {children}
        </div>
      )}
    </div>
  );
}

export function FilterRow({
  label,
  hasSelection,
  onClear,
  children,
}: {
  label: string;
  hasSelection: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div className={css.row}>
      <span className={css.rowLabel}>{label}</span>
      <div className={css.rowControl}>{children}</div>
      <button
        type="button"
        className={`${css.rowClear} ${hasSelection ? css.rowClearActive : ""}`}
        onClick={onClear}
        disabled={!hasSelection}
        aria-label={`Clear ${label} filter`}
        data-tooltip={`Clear ${label} filter`}
      >
        <IconTrash size={15} />
      </button>
    </div>
  );
}
