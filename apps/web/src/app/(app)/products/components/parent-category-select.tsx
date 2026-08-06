"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconSearch } from "@/components/icons";
import css from "../products.module.css";

export type ParentCategoryOption = {
  value: string;
  label: string;
  /** Visual indent depth for hierarchy (0 = top-level). */
  depth?: number;
};

type Props = {
  label: string;
  value: string;
  options: readonly ParentCategoryOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
};

/**
 * Single-select for parent category. Menu is portaled so it is not clipped by
 * modal / list overflow, and uses the products teal focus/option styling.
 */
export function ParentCategorySelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "None (top-level)",
  searchPlaceholder = "Search categories…",
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  const selected = options.find((option) => option.value === value);
  const displayLabel = selected?.label ?? (value ? "Selected" : placeholder);
  const visible = query.trim()
    ? options.filter((option) =>
        option.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : options;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 260 && rect.top > spaceBelow;
    setMenuStyle({
      position: "fixed",
      left: rect.left,
      width: Math.max(rect.width, 220),
      // Above Modal (100) / elevated ConfirmDialog (130).
      zIndex: 140,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(280, rect.top - 16) }
        : { top: rect.bottom + 6, maxHeight: Math.min(280, spaceBelow - 16) }),
    });
  }, [open, options.length, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    searchInputRef.current?.focus({ preventScroll: true });

    function onDoc(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }
    function onScroll(event: Event) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <div className={css.metaParentField}>
      <label className={css.metaParentLabel} htmlFor={id}>
        {label}
      </label>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={`${css.metaParentTrigger} ${open ? css.metaParentTriggerOpen : ""} ${
          value ? css.metaParentTriggerActive : ""
        }`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={css.metaParentValue}>{displayLabel}</span>
        <IconChevronDown size={14} className={css.metaParentChevron} />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className={css.metaParentMenu}
            style={menuStyle}
            role="listbox"
            aria-label={label}
          >
            <div className={css.metaParentSearch}>
              <IconSearch size={14} className={css.metaParentSearchIcon} />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
              />
            </div>
            <div className={css.metaParentOptions}>
              {visible.map((option) => {
                const active = option.value === value;
                const depth = option.depth ?? 0;
                return (
                  <button
                    key={option.value || "__none__"}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`${css.metaParentOption} ${
                      active ? css.metaParentOptionActive : ""
                    }`}
                    style={depth > 0 ? { paddingLeft: `${0.65 + depth * 0.75}rem` } : undefined}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    {active && <IconCheck size={14} />}
                  </button>
                );
              })}
              {visible.length === 0 && (
                <div className={css.metaParentEmpty}>No matching categories</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
