"use client";

import { IconSearch } from "@/components/icons";
import type { PermissionGrantFilter } from "../types";
import css from "../roles.module.css";

const FILTERS: { value: PermissionGrantFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "granted", label: "Granted" },
  { value: "not_granted", label: "Not granted" },
  { value: "sensitive", label: "Sensitive" },
];

type Props = {
  query: string;
  onQueryChange: (value: string) => void;
  filter: PermissionGrantFilter;
  onFilterChange: (value: PermissionGrantFilter) => void;
};

export function PermissionToolbar({ query, onQueryChange, filter, onFilterChange }: Props) {
  return (
    <div className={css.permToolbar}>
      <div className={css.permSearchWrap}>
        <IconSearch size={14} className={css.permSearchIcon} />
        <input
          type="search"
          className={css.permSearchInput}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search permissions…"
          aria-label="Search permissions"
        />
      </div>
      <div className={css.filterChips}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`${css.filterChip}${filter === f.value ? ` ${css.filterChipActive}` : ""}`}
            onClick={() => onFilterChange(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
