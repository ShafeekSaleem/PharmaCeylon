"use client";

import { useEffect, useRef, useState } from "react";
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
};

export function InventoryFilterSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  searchable = false,
  searchPlaceholder = "Search…",
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const filtered = value !== "all" && value !== "";
  const displayLabel =
    selected?.label ??
    (value ? (options.length === 0 ? "Loading…" : "Selected") : "All");
  const visibleOptions =
    searchable && query.trim()
      ? options.filter((option) =>
          option.label.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : options;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function onDocumentClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={css.inventoryFilter} ref={ref}>
      <button
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

      {open && (
        <div className={css.inventoryFilterMenu} role="listbox" aria-label={label}>
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
                  onChange(option.value);
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
      )}
    </div>
  );
}
