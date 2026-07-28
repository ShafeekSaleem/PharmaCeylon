"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconSearch, IconX } from "@/components/icons";
import css from "../purchasing.module.css";

type Option = {
  value: string;
  label: string;
  meta?: string;
};

type Props = {
  label: string;
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  error?: string;
  required?: boolean;
  allowClear?: boolean;
  hideLabel?: boolean;
};

export function PurchasingSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  error,
  required = false,
  allowClear = false,
  hideLabel = false,
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  const selected = options.find((option) => option.value === value);
  const visible = query.trim()
    ? options.filter((option) =>
        `${option.label} ${option.meta ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
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
      width: Math.max(rect.width, 240),
      // Above modal overlays (z-index 100 / 130) without fighting nested dialogs.
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
    // preventScroll avoids jumping the modal / page behind when focusing the portal input.
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
    <div className={css.selectField}>
      <label className={`${css.fieldLabel}${hideLabel ? ` ${css.srOnly}` : ""}`} htmlFor={id}>
        {label}
        {required && !hideLabel && <span className={css.requiredMark}>*</span>}
      </label>
      <div className={css.selectControl}>
        <button
          id={id}
          ref={triggerRef}
          type="button"
          className={`${css.selectTrigger} ${open ? css.selectTriggerOpen : ""} ${
            error ? css.selectTriggerError : ""
          }`}
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <span className={css.selectValue}>
            {selected ? (
              <>
                <span className={css.selectPrimary}>{selected.label}</span>
                {selected.meta && <span className={css.selectMeta}>{selected.meta}</span>}
              </>
            ) : (
              <span className={css.selectPlaceholder}>{placeholder}</span>
            )}
          </span>
          <span className={css.selectActions}>
            {allowClear && value && !disabled && (
              <span
                role="button"
                tabIndex={-1}
                className={css.selectClear}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange("");
                }}
                aria-label="Clear selection"
              >
                <IconX size={14} />
              </span>
            )}
            <IconChevronDown size={14} className={css.selectChevron} />
          </span>
        </button>
      </div>
      {error && <span className={css.fieldError}>{error}</span>}

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div ref={menuRef} className={css.selectMenu} style={menuStyle} role="listbox" aria-label={label}>
            <div className={css.selectSearch}>
              <IconSearch size={14} />
              <input
                ref={searchInputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
              />
            </div>
            <div className={css.selectOptions}>
              {visible.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`${css.selectOption} ${active ? css.selectOptionActive : ""}`}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className={css.selectOptionText}>
                      <span>{option.label}</span>
                      {option.meta && <span className={css.selectMeta}>{option.meta}</span>}
                    </span>
                    {active && <IconCheck size={14} />}
                  </button>
                );
              })}
              {visible.length === 0 && (
                <div className={css.selectEmpty}>No matching options</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
