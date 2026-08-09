"use client";

import css from "../dashboard.module.css";

export type PeriodOption = { value: string; label: string };

type Props = {
  value: string;
  options: readonly PeriodOption[];
  onChange: (value: string) => void;
  "aria-label": string;
};

/** Always-visible segmented toggle — replaces the dropdown for short option lists. */
export function PeriodToggle({ value, options, onChange, ...rest }: Props) {
  return (
    <div className={css.periodToggle} role="group" {...rest}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={css.periodToggleBtn}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
