"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "@/components/icons";
import css from "../dashboard.module.css";

export type BranchMultiSelectOption = { value: string; label: string; color?: string };

type Props = {
  options: BranchMultiSelectOption[];
  /** Empty array means "All branches" — no filter applied. */
  selected: string[];
  onChange: (next: string[]) => void;
  "aria-label"?: string;
};

/** Compact multiselect dropdown for comparing a subset of branches on one
 * chart. Empty selection == "All branches"; picking any branch switches to
 * that explicit subset. */
export function BranchMultiSelect({ options, selected, onChange, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(event: MouseEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
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

  const isAll = selected.length === 0;
  const triggerLabel = isAll
    ? "All branches"
    : selected.length === 1
      ? options.find((o) => o.value === selected[0])?.label ?? "1 branch"
      : `${selected.length} branches`;

  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  return (
    <div className={css.branchMultiSelect} ref={ref}>
      <button
        type="button"
        className={`${css.branchMultiSelectTrigger} ${!isAll ? css.branchMultiSelectTriggerActive : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={rest["aria-label"] ?? "Filter branches"}
      >
        <span>{triggerLabel}</span>
        <IconChevronDown size={13} className={css.branchMultiSelectChevron} />
      </button>

      {open ? (
        <div className={css.branchMultiSelectMenu} role="listbox" aria-multiselectable aria-label="Branches">
          <button
            type="button"
            role="option"
            aria-selected={isAll}
            className={`${css.branchMultiSelectOption} ${isAll ? css.branchMultiSelectOptionActive : ""}`}
            onClick={() => onChange([])}
          >
            <span className={css.branchMultiSelectOptionLabel}>All branches</span>
            {isAll ? <IconCheck size={13} /> : null}
          </button>
          <div className={css.branchMultiSelectDivider} aria-hidden />
          {options.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={checked}
                className={`${css.branchMultiSelectOption} ${checked ? css.branchMultiSelectOptionActive : ""}`}
                onClick={() => toggle(option.value)}
              >
                {option.color ? (
                  <span className={css.branchMultiSelectDot} style={{ background: option.color }} aria-hidden />
                ) : null}
                <span className={css.branchMultiSelectOptionLabel}>{option.label}</span>
                {checked ? <IconCheck size={13} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
