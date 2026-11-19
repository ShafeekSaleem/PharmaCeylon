"use client";

import styles from "./filter-chips.module.css";
import { DISPLAY_LOCALE } from "@pharmaceylon/shared";

export type FilterChip<Id extends string = string> = {
  id: Id;
  label: string;
  /** How many rows this filter would show. Omitted (or null) while it is still loading. */
  count?: number | null;
  disabled?: boolean;
  /** Says why a chip is disabled, or what it means when the label alone is short. */
  hint?: string;
};

export type FilterChipsProps<Id extends string = string> = {
  chips: FilterChip<Id>[];
  /**
   * The chip whose filter is applied. At most one chip is ever filled: `null` when the list
   * is filtered some other way (the filter panel, a pasted URL) and no single chip describes it.
   */
  active: Id | null;
  onChange: (id: Id) => void;
  /** Names the group for screen readers: "Product status". */
  label: string;
  className?: string;
};

/**
 * The quick filters above a list (#205, shared list pattern).
 *
 * Every chip is neutral; only the applied one is filled, so the eye finds it at once. They used
 * to be tinted one colour each (teal, green, sky, amber, rose), which made five equally loud
 * buttons and let colour stand in for meaning. The count sits beside each label, so a chip
 * says what it would show before you press it, and the list total is stated in one place.
 */
export function FilterChips<Id extends string = string>({
  chips,
  active,
  onChange,
  label,
  className,
}: FilterChipsProps<Id>) {
  return (
    <div
      className={`${styles.chips}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={label}
    >
      {chips.map((chip) => {
        const selected = chip.id === active;
        const count =
          chip.count != null ? chip.count.toLocaleString(DISPLAY_LOCALE) : undefined;
        return (
          <button
            key={chip.id}
            type="button"
            className={`${styles.chip}${selected ? ` ${styles.chipActive}` : ""}`}
            aria-pressed={selected}
            disabled={chip.disabled}
            title={chip.hint}
            onClick={() => onChange(chip.id)}
          >
            <span>{chip.label}</span>
            {count !== undefined && (
              <span className={styles.count} data-testid="filter-chip-count">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
