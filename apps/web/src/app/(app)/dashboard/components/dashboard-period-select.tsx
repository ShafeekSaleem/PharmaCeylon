"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "@/components/icons";
import css from "../dashboard.module.css";

export type PeriodOption = { value: string; label: string };

type Props = {
  label: string;
  value: string;
  options: readonly PeriodOption[];
  onChange: (value: string) => void;
  /** Optional compact trigger for dense dashboard headers. */
  compact?: boolean;
};

/** Themed select matching InventoryFilterSelect interaction / tokens. */
export function DashboardPeriodSelect({
  label,
  value,
  options,
  onChange,
  compact = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 220 && rect.top > spaceBelow;
    setMenuStyle({
      position: "fixed",
      left: rect.left,
      width: Math.max(rect.width, 160),
      zIndex: 200,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(240, rect.top - 16) }
        : { top: rect.bottom + 6, maxHeight: Math.min(240, spaceBelow - 16) }),
    });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScroll(e: Event) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const menu = (
    <div
      ref={menuRef}
      className={css.periodMenu}
      style={menuStyle}
      role="listbox"
      aria-label={label}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={active}
            className={`${css.periodOption} ${active ? css.periodOptionActive : ""}`}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            <span>{option.label}</span>
            {active ? <IconCheck size={14} /> : null}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={`${css.periodSelectWrap} ${compact ? css.periodSelectCompact : ""}`} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={`${css.periodTrigger} ${open ? css.periodTriggerOpen : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
      >
        <span className={css.periodTriggerText}>
          <span className={css.periodTriggerLabel}>{label}</span>
          <span>{selected?.label ?? "Select"}</span>
        </span>
        <IconChevronDown size={14} className={css.periodChevron} />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : null}
    </div>
  );
}
