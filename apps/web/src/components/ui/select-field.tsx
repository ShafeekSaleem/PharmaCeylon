"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";
import styles from "./select-field.module.css";

export type SelectFieldOption = {
  value: string;
  label: string;
  shortLabel?: string;
};

export type SelectFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectFieldOption[];
  disabled?: boolean;
  hint?: string;
  error?: string;
  required?: boolean;
  fullWidth?: boolean;
  className?: string;
  id?: string;
  hideLabel?: boolean;
  ariaLabel?: string;
  wideMenu?: boolean;
};

/**
 * A fully custom single-select — the closed control matches FormField's `.control` styling,
 * but (unlike a native `<select>`) the open option list is real themed DOM, not an
 * OS-rendered popup, so it stays on-brand instead of falling back to native browser chrome.
 */
export function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
  hint,
  error,
  required,
  fullWidth = true,
  className,
  id,
  hideLabel = false,
  ariaLabel,
  wideMenu = false,
}: SelectFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hasError = !!error;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [open, activeIndex]);

  function commit(index: number) {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  const wrapCls = [
    styles.field,
    fullWidth ? styles.fullWidth : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const controlCls = [
    styles.control,
    hasError ? styles.error : "",
    open ? styles.controlOpen : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapCls} ref={rootRef}>
      <label
        htmlFor={fieldId}
        className={hideLabel ? styles.srOnly : styles.label}
      >
        {label}
        {required && <span className={styles.required}>*</span>}
      </label>
      <div className={styles.controlWrap}>
        <button
          type="button"
          id={fieldId}
          className={controlCls}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={handleKeyDown}
        >
          <span className={styles.controlValue}>
            {selected?.shortLabel ?? selected?.label ?? ""}
          </span>
          <IconChevronDown size={14} className={styles.chevron} />
        </button>
        {open && !disabled ? (
          <ul
            className={`${styles.menu}${wideMenu ? ` ${styles.menuWide}` : ""}`}
            role="listbox"
            aria-labelledby={fieldId}
            ref={listRef}
          >
            {options.map((opt, i) => (
              <li
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                className={`${styles.option}${opt.value === value ? ` ${styles.optionSelected}` : ""}${
                  i === activeIndex ? ` ${styles.optionActive}` : ""
                }`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(i);
                }}
              >
                <span>{opt.label}</span>
                {opt.value === value ? <IconCheck size={14} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {hasError ? (
        <p className={styles.errorText}>{error}</p>
      ) : hint ? (
        <p className={styles.hintText}>{hint}</p>
      ) : null}
    </div>
  );
}
