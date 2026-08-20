"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";
import css from "../reports.module.css";

export type ReportSelectOption = { value: string; label: string; disabled?: boolean };

type Props = {
  value: string;
  options: ReportSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
};

/** Themed trigger+menu dropdown — replaces the native `<select>` (which can't be restyled to match
 * the app's own card/border/focus-ring language) with the same pattern already used for Inventory's
 * filter selects, sized to sit inline in the Reports filter bar. */
export function ReportSelect({ value, options, onChange, disabled = false, placeholder = "Select", ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={css.rsWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${css.rsTrigger}${open ? ` ${css.rsTriggerOpen}` : ""}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={css.rsTriggerLabel}>{selected?.label ?? placeholder}</span>
        <IconChevronDown size={14} className={css.rsChevron} />
      </button>
      {open ? (
        <div className={css.rsMenu} role="listbox" aria-label={ariaLabel}>
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                disabled={o.disabled}
                className={`${css.rsOption}${active ? ` ${css.rsOptionActive}` : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                {active ? <IconCheck size={14} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
