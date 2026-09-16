"use client";

import { IconCalendar } from "@/components/icons";
import css from "./date-range-field.module.css";

type Props = {
  /** Names the pair for screen readers: "Created date range", "Movement dates". */
  label: string;
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  /** Match the height of neighbouring toolbar controls. */
  size?: "md" | "lg";
  className?: string;
};

/**
 * From → To date pair sized to sit in a filter toolbar next to select triggers.
 *
 * Purchasing had grown this as a page-local control; Inventory's movement history needed the
 * same thing and started stacking two full form fields instead. One control, both places.
 * The end date can't be set before the start, and the reverse.
 */
export function DateRangeField({
  label,
  from,
  to,
  onFromChange,
  onToChange,
  size = "md",
  className,
}: Props) {
  const filled = Boolean(from || to);
  return (
    <div
      className={[css.dateRange, filled ? css.filled : "", size === "lg" ? css.large : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label={label}
    >
      <span className={css.icon} aria-hidden>
        <IconCalendar size={14} />
      </span>
      <div className={css.fields}>
        <label className={css.field}>
          <span className={css.fieldLabel}>From</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => onFromChange(e.target.value)}
            aria-label={`${label}: from`}
          />
        </label>
        <span className={css.separator} aria-hidden>
          →
        </span>
        <label className={css.field}>
          <span className={css.fieldLabel}>To</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => onToChange(e.target.value)}
            aria-label={`${label}: to`}
          />
        </label>
      </div>
    </div>
  );
}
