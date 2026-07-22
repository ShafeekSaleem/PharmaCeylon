"use client";

import { useEffect, useRef, useState } from "react";
import { IconFilter, IconTrash } from "@/components/icons";
import css from "../inventory.module.css";

export type InventoryCatalogFilters = {
  categories: string[];
  brands: string[];
  tags: string[];
  dosageForms: string[];
};

export const EMPTY_INVENTORY_CATALOG_FILTERS: InventoryCatalogFilters = {
  categories: [],
  brands: [],
  tags: [],
  dosageForms: [],
};

type FilterOptions = {
  categories: { value: string; label: string }[];
  brands: { value: string; label: string }[];
  tags: { value: string; label: string }[];
  dosageForms: { value: string; label: string }[];
};

type Props = {
  value: InventoryCatalogFilters;
  options: FilterOptions;
  onChange: (filters: InventoryCatalogFilters) => void;
};

export function inventoryCatalogFiltersAreActive(filters: InventoryCatalogFilters) {
  return Object.values(filters).some((values) => values.length > 0);
}

export function InventoryMoreFilters({ value, options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = inventoryCatalogFiltersAreActive(value);

  useEffect(() => {
    if (!open) return;
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

  const toggle = (
    key: keyof InventoryCatalogFilters,
    optionValue: string,
  ) => {
    const selected = value[key];
    onChange({
      ...value,
      [key]: selected.includes(optionValue)
        ? selected.filter((item) => item !== optionValue)
        : [...selected, optionValue],
    });
  };

  return (
    <div className={css.moreFiltersWrap} ref={ref}>
      <button
        type="button"
        className={`${css.moreFiltersButton} ${
          active ? css.moreFiltersButtonActive : ""
        }`}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tooltip={
          active
            ? "Edit catalog filters (filters active)"
            : "Filter by category, brand, tags, or dosage form"
        }
      >
        <IconFilter size={15} />
        More filters
        {active && <span className={css.moreFiltersBadge} aria-hidden />}
      </button>

      {open && (
        <div className={css.moreFiltersPanel} role="dialog" aria-label="More inventory filters">
          <div className={css.moreFiltersHeader}>
            <div>
              <h3>Catalog filters</h3>
              <p>Narrow this inventory view using product metadata.</p>
            </div>
            <button
              type="button"
              className={css.moreFiltersClear}
              onClick={() => onChange(EMPTY_INVENTORY_CATALOG_FILTERS)}
              disabled={!active}
              data-tooltip={
                active ? "Clear all catalog filters" : "No catalog filters to clear"
              }
            >
              <IconTrash size={14} />
              Clear all
            </button>
          </div>

          <div className={css.moreFiltersGrid}>
            <FilterGroup
              label="Category"
              options={options.categories}
              selected={value.categories}
              onToggle={(item) => toggle("categories", item)}
            />
            <FilterGroup
              label="Brand"
              options={options.brands}
              selected={value.brands}
              onToggle={(item) => toggle("brands", item)}
            />
            <FilterGroup
              label="Tags"
              options={options.tags}
              selected={value.tags}
              onToggle={(item) => toggle("tags", item)}
            />
            <FilterGroup
              label="Dosage form"
              options={options.dosageForms}
              selected={value.dosageForms}
              onToggle={(item) => toggle("dosageForms", item)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset className={css.catalogFilterGroup}>
      <legend>
        {label}
        {selected.length > 0 && <span>{selected.length}</span>}
      </legend>
      <div className={css.catalogFilterOptions}>
        {options.length === 0 ? (
          <span className={css.catalogFilterEmpty}>No options</span>
        ) : (
          options.map((option) => (
            <label key={option.value} className={css.catalogFilterOption}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => onToggle(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))
        )}
      </div>
    </fieldset>
  );
}
