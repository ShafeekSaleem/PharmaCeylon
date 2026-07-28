"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconSearch } from "@/components/icons";
import css from "../inventory.module.css";

type Option = {
  value: string;
  label: string;
};

type Props = {
  label: string;
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Shown on the trigger when value is empty; not listed as an option. */
  placeholder?: string;
  /** Clicking the selected option again clears to `deselectValue`. */
  allowDeselect?: boolean;
  deselectValue?: string;
  /** Render the menu in a portal to escape overflow/stacking contexts (e.g. sticky side cards). */
  portal?: boolean;
};

export function InventoryFilterSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  searchable = false,
  searchPlaceholder = "Search…",
  placeholder = "All",
  allowDeselect = false,
  deselectValue = "",
  portal = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value);
  const filtered = value !== "all" && value !== "";
  const displayLabel =
    selected?.label ??
    (value ? (options.length === 0 ? "Loading…" : "Selected") : placeholder);
  const visibleOptions =
    searchable && query.trim()
      ? options.filter((option) =>
          option.label.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : options;

  useLayoutEffect(() => {
    if (!open || !portal || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 260 && rect.top > spaceBelow;
    setMenuStyle({
      position: "fixed",
      left: rect.left,
      width: Math.max(rect.width, 170),
      zIndex: 200,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(280, rect.top - 16) }
        : { top: rect.bottom + 6, maxHeight: Math.min(280, spaceBelow - 16) }),
    });
  }, [open, portal, options.length, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function onDocumentClick(event: MouseEvent) {
      const target = event.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    }
    function onScroll(event: Event) {
      if (!portal) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKeyDown, portal);
    if (portal) {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);
    }
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown, portal);
      if (portal) {
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onScroll);
      }
    };
  }, [open, portal]);

  const menu = (
    <div
      ref={portal ? menuRef : undefined}
      className={css.inventoryFilterMenu}
      style={portal ? menuStyle : undefined}
      role="listbox"
      aria-label={label}
    >
      {searchable && (
        <div className={css.inventoryFilterSearch}>
          <IconSearch size={14} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            autoFocus
          />
        </div>
      )}
      <div className={css.inventoryFilterOptions}>
        {visibleOptions.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={active}
              className={`${css.inventoryFilterOption} ${
                active ? css.inventoryFilterOptionActive : ""
              }`}
              onClick={() => {
                if (allowDeselect && active) {
                  onChange(deselectValue);
                } else {
                  onChange(option.value);
                }
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {active && <IconCheck size={14} />}
            </button>
          );
        })}
        {visibleOptions.length === 0 && (
          <div className={css.inventoryFilterEmpty}>No matching options</div>
        )}
      </div>
    </div>
  );

  return (
    <div className={css.inventoryFilter} ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className={`${css.inventoryFilterTrigger} ${
          open ? css.inventoryFilterTriggerOpen : ""
        } ${filtered ? css.inventoryFilterTriggerActive : ""}`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className={css.inventoryFilterText}>
          <span className={css.inventoryFilterLabel}>{label}</span>
          <span>{displayLabel}</span>
        </span>
        <IconChevronDown size={14} className={css.inventoryFilterChevron} />
      </button>

      {open &&
        (portal && typeof document !== "undefined"
          ? createPortal(menu, document.body)
          : menu)}
    </div>
  );
}
