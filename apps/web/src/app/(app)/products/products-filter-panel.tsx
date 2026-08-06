"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  IconChevronDown,
  IconFilter,
  IconSearch,
  IconTrash,
} from "@/components/icons";
import css from "./products-filter-panel.module.css";

export type FacetEntry = {
  value: string;
  count: number;
  label?: string;
  parentCategoryId?: string | null;
  parentName?: string | null;
};

export type ProductFilters = {
  schedules: string[];
  dosageForms: string[];
  formGroups: string[];
  registrationTypes: string[];
  brands: string[];
  tags: string[];
  status: ("active" | "inactive")[];
  controlled: ("true" | "false")[];
  lowStock: boolean;
  requiresPrescription: boolean;
};

export const EMPTY_PRODUCT_FILTERS: ProductFilters = {
  schedules: [],
  dosageForms: [],
  formGroups: [],
  registrationTypes: [],
  brands: [],
  tags: [],
  status: [],
  controlled: [],
  lowStock: false,
  requiresPrescription: false,
};

export function productFiltersAreActive(filters: ProductFilters): boolean {
  return (
    filters.schedules.length > 0 ||
    filters.dosageForms.length > 0 ||
    filters.formGroups.length > 0 ||
    filters.registrationTypes.length > 0 ||
    filters.brands.length > 0 ||
    filters.tags.length > 0 ||
    filters.status.length > 0 ||
    filters.controlled.length > 0 ||
    filters.lowStock ||
    filters.requiresPrescription
  );
}

export function productFiltersToQueryParams(filters: ProductFilters): {
  status: string;
  dosageForm?: string;
  brandName?: string;
  schedule?: string;
  categoryId?: string;
  tagId?: string;
  isControlled?: string;
  lowStock?: boolean;
  requiresPrescription?: boolean;
} {
  const params: {
    status: string;
    dosageForm?: string;
    brandName?: string;
    schedule?: string;
    categoryId?: string;
    tagId?: string;
    isControlled?: string;
    lowStock?: boolean;
    requiresPrescription?: boolean;
  } = { status: "all" };

  if (filters.dosageForms.length) {
    params.dosageForm = filters.dosageForms.join(",");
  }
  if (filters.brands.length) {
    params.brandName = filters.brands.join(",");
  }
  if (filters.schedules.length) {
    params.schedule = filters.schedules.join(",");
  }
  const categoryIds = [...filters.formGroups, ...filters.registrationTypes];
  if (categoryIds.length) {
    params.categoryId = categoryIds.join(",");
  }
  if (filters.tags.length) {
    params.tagId = filters.tags.join(",");
  }
  if (filters.status.length > 0) {
    params.status = filters.status.join(",");
  }
  if (filters.controlled.length > 0) {
    params.isControlled = filters.controlled.join(",");
  }
  if (filters.lowStock) {
    params.lowStock = true;
  }
  if (filters.requiresPrescription) {
    params.requiresPrescription = true;
  }
  return params;
}

export type FilterFacets = {
  brands: FacetEntry[];
  dosageForms: FacetEntry[];
  schedules?: FacetEntry[];
  formGroups?: FacetEntry[];
  registrationTypes?: FacetEntry[];
  categories?: FacetEntry[];
  tags?: FacetEntry[];
  status: FacetEntry[];
  controlled: { value: boolean; count: number }[];
  requiresPrescription?: { value: boolean; count: number }[];
};

type ProductsFilterPanelProps = {
  facets: FilterFacets | null;
  applied: ProductFilters;
  onApply: (filters: ProductFilters) => void;
  hasBranch?: boolean;
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
};

const CONTROLLED_LABELS: Record<string, string> = {
  true: "Controlled",
  false: "Non-controlled",
};

function facetOptions(
  entries: FacetEntry[],
  labelMap?: Record<string, string>,
): { value: string; label: string }[] {
  return entries.map((e) => ({
    value: e.value,
    label: `${labelMap?.[e.value] ?? e.label ?? e.value} (${e.count})`,
  }));
}

function controlledOptions(
  entries: { value: boolean; count: number }[],
): { value: string; label: string }[] {
  return entries.map((e) => {
    const key = e.value ? "true" : "false";
    return {
      value: key,
      label: `${CONTROLLED_LABELS[key]} (${e.count})`,
    };
  });
}

export function ProductsFilterPanel({
  facets,
  applied,
  onApply,
  hasBranch = false,
}: ProductsFilterPanelProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = productFiltersAreActive(applied);

  const patch = (updater: (prev: ProductFilters) => ProductFilters) => {
    onApply(updater(applied));
  };

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={css.wrap} ref={wrapRef}>
      <button
        type="button"
        className={`${css.filterBtn} ${active ? css.filterBtnActive : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <IconFilter size={15} />
        Filter
        <span
          className={`${css.filterBadge} ${active ? css.filterBadgeVisible : ""}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className={css.panel} role="dialog" aria-label="Filter products">
          <h3 className={css.panelTitle}>Filter</h3>

          <FilterRow
            label="Schedule"
            hasSelection={applied.schedules.length > 0}
            onClear={() => patch((d) => ({ ...d, schedules: [] }))}
          >
            <MultiSelectDropdown
              options={facetOptions(facets?.schedules ?? [])}
              selected={applied.schedules}
              onChange={(schedules) => patch((d) => ({ ...d, schedules }))}
              searchPlaceholder="Search schedules…"
            />
          </FilterRow>

          <FilterRow
            label="Form group"
            hasSelection={applied.formGroups.length > 0}
            onClear={() => patch((d) => ({ ...d, formGroups: [] }))}
          >
            <MultiSelectDropdown
              options={facetOptions(facets?.formGroups ?? [])}
              selected={applied.formGroups}
              onChange={(formGroups) => patch((d) => ({ ...d, formGroups }))}
              searchPlaceholder="Search forms…"
            />
          </FilterRow>

          <FilterRow
            label="Brand"
            hasSelection={applied.brands.length > 0}
            onClear={() => patch((d) => ({ ...d, brands: [] }))}
          >
            <MultiSelectDropdown
              options={facetOptions(facets?.brands ?? [])}
              selected={applied.brands}
              onChange={(brands) => patch((d) => ({ ...d, brands }))}
              searchPlaceholder="Search brands…"
            />
          </FilterRow>

          <FilterRow
            label="Registration type"
            hasSelection={applied.registrationTypes.length > 0}
            onClear={() => patch((d) => ({ ...d, registrationTypes: [] }))}
          >
            <MultiSelectDropdown
              options={facetOptions(facets?.registrationTypes ?? [])}
              selected={applied.registrationTypes}
              onChange={(registrationTypes) =>
                patch((d) => ({ ...d, registrationTypes }))
              }
              searchPlaceholder="Search types…"
            />
          </FilterRow>

          <FilterRow
            label="Tag"
            hasSelection={applied.tags.length > 0}
            onClear={() => patch((d) => ({ ...d, tags: [] }))}
          >
            <MultiSelectDropdown
              options={facetOptions(facets?.tags ?? [])}
              selected={applied.tags}
              onChange={(tags) => patch((d) => ({ ...d, tags }))}
              searchPlaceholder="Search tags…"
            />
          </FilterRow>

          <FilterRow
            label="Controlled"
            hasSelection={applied.controlled.length > 0}
            onClear={() => patch((d) => ({ ...d, controlled: [] }))}
          >
            <MultiSelectDropdown
              options={controlledOptions(facets?.controlled ?? [])}
              selected={applied.controlled}
              onChange={(controlled) =>
                patch((d) => ({
                  ...d,
                  controlled: controlled as ("true" | "false")[],
                }))
              }
              searchPlaceholder="Search…"
              searchable={false}
            />
          </FilterRow>

          <FilterRow
            label="Status"
            hasSelection={applied.status.length > 0}
            onClear={() => patch((d) => ({ ...d, status: [] }))}
          >
            <MultiSelectDropdown
              options={facetOptions(facets?.status ?? [], STATUS_LABELS)}
              selected={applied.status}
              onChange={(status) =>
                patch((d) => ({
                  ...d,
                  status: status as ("active" | "inactive")[],
                }))
              }
              searchPlaceholder="Search…"
              searchable={false}
            />
          </FilterRow>

          <FilterRow
            label="Low stock"
            hasSelection={applied.lowStock}
            onClear={() => patch((d) => ({ ...d, lowStock: false }))}
          >
            <label className={css.lowStockToggle}>
              <input
                type="checkbox"
                checked={applied.lowStock}
                disabled={!hasBranch}
                onChange={(e) => patch((d) => ({ ...d, lowStock: e.target.checked }))}
              />
              <span>{hasBranch ? "Below reorder level at branch" : "Select a branch first"}</span>
            </label>
          </FilterRow>

          <AdvancedDosageFilter
            facets={facets}
            applied={applied}
            onChange={(dosageForms) => patch((d) => ({ ...d, dosageForms }))}
            onClear={() => patch((d) => ({ ...d, dosageForms: [] }))}
          />
        </div>
      )}
    </div>
  );
}

function AdvancedDosageFilter({
  facets,
  applied,
  onChange,
  onClear,
}: {
  facets: FilterFacets | null;
  applied: ProductFilters;
  onChange: (dosageForms: string[]) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(applied.dosageForms.length > 0);
  const count = facets?.dosageForms?.length ?? 0;

  return (
    <div className={css.advancedBlock}>
      <button
        type="button"
        className={css.advancedToggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <IconChevronDown
          size={14}
          className={`${css.advancedChevron} ${open ? css.advancedChevronOpen : ""}`}
        />
        Advanced: exact dosage / presentation
        {count > 0 ? ` (${count})` : ""}
        {applied.dosageForms.length > 0 ? (
          <span className={css.advancedActive}>
            {applied.dosageForms.length} selected
          </span>
        ) : null}
      </button>
      {open ? (
        <FilterRow
          label="Dosage"
          hasSelection={applied.dosageForms.length > 0}
          onClear={onClear}
        >
          <MultiSelectDropdown
            options={facetOptions(facets?.dosageForms ?? [])}
            selected={applied.dosageForms}
            onChange={onChange}
            searchPlaceholder="Search presentations…"
          />
        </FilterRow>
      ) : null}
    </div>
  );
}

function FilterRow({
  label,
  hasSelection,
  onClear,
  children,
}: {
  label: string;
  hasSelection: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div className={css.row}>
      <span className={css.rowLabel}>{label}</span>
      <div className={css.rowControl}>{children}</div>
      <button
        type="button"
        className={`${css.rowClear} ${hasSelection ? css.rowClearActive : ""}`}
        onClick={onClear}
        disabled={!hasSelection}
        aria-label={`Clear ${label} filter`}
        data-tooltip={`Clear ${label} filter`}
      >
        <IconTrash size={15} />
      </button>
    </div>
  );
}

function MultiSelectDropdown({
  options,
  selected,
  onChange,
  searchPlaceholder,
  searchable = true,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  searchPlaceholder: string;
  searchable?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      setQuery("");
      return;
    }
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const filtered = searchable
    ? options.filter((o) =>
        o.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : options;

  const summary =
    selected.length === 0
      ? options.length
        ? "All"
        : "—"
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  return (
    <div className={css.multiWrap}>
      <button
        ref={triggerRef}
        type="button"
        className={`${css.multiTrigger} ${menuOpen ? css.multiTriggerOpen : ""} ${selected.length > 0 ? css.multiTriggerFiltered : ""}`}
        onClick={() => setMenuOpen((o) => !o)}
        aria-expanded={menuOpen}
        aria-controls={listId}
      >
        <span className={css.multiSummary}>{summary}</span>
        <IconChevronDown size={14} className={css.multiChevron} />
      </button>

      {menuOpen && (
        <div ref={menuRef} id={listId} className={css.multiMenu} role="listbox">
          {searchable && (
            <div className={css.multiSearch}>
              <IconSearch size={14} className={css.multiSearchIcon} />
              <input
                type="text"
                className={css.multiSearchInput}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <ul className={css.multiList}>
            {filtered.length === 0 ? (
              <li className={css.multiEmpty}>No matches</li>
            ) : (
              filtered.map((opt) => (
                <li key={opt.value}>
                  <label className={css.multiOption}>
                    <input
                      type="checkbox"
                      checked={selected.includes(opt.value)}
                      onChange={() => toggle(opt.value)}
                    />
                    <span>{opt.label}</span>
                  </label>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
