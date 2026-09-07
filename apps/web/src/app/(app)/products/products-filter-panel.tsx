"use client";

import {
  FilterPopover,
  FilterRow,
  TreeMultiSelect,
  flattenCategoryTree,
  type CategoryTreeNode,
} from "@/components/ui";
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
  formGroups: string[];
  registrationTypes: string[];
  /** Commercial (merchandising) Category filter — independent of Schedule/Form/RegType. */
  commercialCategories: string[];
  brands: string[];
  tags: string[];
  status: ("active" | "inactive")[];
  controlled: ("true" | "false")[];
  lowStock: boolean;
  requiresPrescription: boolean;
};

export const EMPTY_PRODUCT_FILTERS: ProductFilters = {
  schedules: [],
  formGroups: [],
  registrationTypes: [],
  commercialCategories: [],
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
    filters.formGroups.length > 0 ||
    filters.registrationTypes.length > 0 ||
    filters.commercialCategories.length > 0 ||
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
  brandName?: string;
  schedule?: string;
  categoryId?: string;
  commercialCategoryId?: string;
  tagId?: string;
  isControlled?: string;
  lowStock?: boolean;
  requiresPrescription?: boolean;
} {
  const params: {
    status: string;
    brandName?: string;
    schedule?: string;
    categoryId?: string;
    commercialCategoryId?: string;
    tagId?: string;
    isControlled?: string;
    lowStock?: boolean;
    requiresPrescription?: boolean;
  } = { status: "all" };

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
  if (filters.commercialCategories.length) {
    params.commercialCategoryId = filters.commercialCategories.join(",");
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

/** Alias kept for readability at Products-page call sites. */
export type CommercialCategoryFacetNode = CategoryTreeNode;

export type FilterFacets = {
  brands: FacetEntry[];
  dosageForms: FacetEntry[];
  schedules?: FacetEntry[];
  formGroups?: FacetEntry[];
  registrationTypes?: FacetEntry[];
  categories?: FacetEntry[];
  /** Active COMMERCIAL department → category tree — this is the Products page "Category" filter. */
  commercialDepartments?: CommercialCategoryFacetNode[];
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
  /** Reference scope drops the filters that only mean something for stock the shop holds. */
  scope?: "mine" | "reference";
};

export const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
};

export const CONTROLLED_LABELS: Record<string, string> = {
  true: "Controlled",
  false: "Non-controlled",
};

function facetOptions(
  entries: FacetEntry[],
  labelMap?: Record<string, string>,
): { value: string; label: string; count: number }[] {
  return entries.map((e) => ({
    value: e.value,
    label: labelMap?.[e.value] ?? e.label ?? e.value,
    count: e.count,
  }));
}

function controlledOptions(
  entries: { value: boolean; count: number }[],
): { value: string; label: string; count: number }[] {
  return entries.map((e) => {
    const key = e.value ? "true" : "false";
    return {
      value: key,
      label: CONTROLLED_LABELS[key],
      count: e.count,
    };
  });
}

export function ProductsFilterPanel({
  facets,
  applied,
  onApply,
  hasBranch = false,
  scope = "mine",
}: ProductsFilterPanelProps) {
  const active = productFiltersAreActive(applied);
  /*
   * Status and Low stock answer questions the reference catalog can't have. Every register row
   * is REFERENCE, and a reference row can never hold stock — the moment any arrives,
   * `ensureProductsRanged` promotes it into My Products — so both filters would return either
   * everything or nothing.
   */
  const stockAware = scope !== "reference";

  const patch = (updater: (prev: ProductFilters) => ProductFilters) => {
    onApply(updater(applied));
  };

  return (
    <FilterPopover active={active} panelAriaLabel="Filter products">
          <FilterRow
            label="Category"
            hasSelection={applied.commercialCategories.length > 0}
            onClear={() => patch((d) => ({ ...d, commercialCategories: [] }))}
          >
            <TreeMultiSelect
              options={flattenCategoryTree(facets?.commercialDepartments)}
              selected={applied.commercialCategories}
              onChange={(commercialCategories) => patch((d) => ({ ...d, commercialCategories }))}
              searchPlaceholder="Search categories…"
              menuPlacement="right"
            />
          </FilterRow>

          <p style={{ margin: "-0.4rem 0 0.6rem", fontSize: "0.75rem", color: "var(--pc-muted-fg, #888)" }}>
            Category is the merchandise/business grouping. Schedule, Form group, and Registration
            type below are regulatory classifications from the NMRA catalog.
          </p>

          <FilterRow
            label="Schedule"
            hasSelection={applied.schedules.length > 0}
            onClear={() => patch((d) => ({ ...d, schedules: [] }))}
          >
            <TreeMultiSelect
              options={facetOptions(facets?.schedules ?? [])}
              selected={applied.schedules}
              onChange={(schedules) => patch((d) => ({ ...d, schedules }))}
              searchPlaceholder="Search schedules…"
              menuPlacement="right"
            />
          </FilterRow>

          <FilterRow
            label="Form group"
            hasSelection={applied.formGroups.length > 0}
            onClear={() => patch((d) => ({ ...d, formGroups: [] }))}
          >
            <TreeMultiSelect
              options={facetOptions(facets?.formGroups ?? [])}
              selected={applied.formGroups}
              onChange={(formGroups) => patch((d) => ({ ...d, formGroups }))}
              searchPlaceholder="Search forms…"
              menuPlacement="right"
            />
          </FilterRow>

          <FilterRow
            label="Brand"
            hasSelection={applied.brands.length > 0}
            onClear={() => patch((d) => ({ ...d, brands: [] }))}
          >
            <TreeMultiSelect
              options={facetOptions(facets?.brands ?? [])}
              selected={applied.brands}
              onChange={(brands) => patch((d) => ({ ...d, brands }))}
              searchPlaceholder="Search brands…"
              menuPlacement="right"
            />
          </FilterRow>

          <FilterRow
            label="Registration type"
            hasSelection={applied.registrationTypes.length > 0}
            onClear={() => patch((d) => ({ ...d, registrationTypes: [] }))}
          >
            <TreeMultiSelect
              options={facetOptions(facets?.registrationTypes ?? [])}
              selected={applied.registrationTypes}
              onChange={(registrationTypes) =>
                patch((d) => ({ ...d, registrationTypes }))
              }
              searchPlaceholder="Search types…"
              menuPlacement="right"
            />
          </FilterRow>

          <FilterRow
            label="Tag"
            hasSelection={applied.tags.length > 0}
            onClear={() => patch((d) => ({ ...d, tags: [] }))}
          >
            <TreeMultiSelect
              options={facetOptions(facets?.tags ?? [])}
              selected={applied.tags}
              onChange={(tags) => patch((d) => ({ ...d, tags }))}
              searchPlaceholder="Search tags…"
              menuPlacement="right"
            />
          </FilterRow>

          <FilterRow
            label="Controlled"
            hasSelection={applied.controlled.length > 0}
            onClear={() => patch((d) => ({ ...d, controlled: [] }))}
          >
            <TreeMultiSelect
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
              menuPlacement="right"
            />
          </FilterRow>

          {stockAware && (
            <FilterRow
              label="Status"
              hasSelection={applied.status.length > 0}
              onClear={() => patch((d) => ({ ...d, status: [] }))}
            >
              <TreeMultiSelect
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
                menuPlacement="right"
              />
            </FilterRow>
          )}

          {stockAware && (
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
          )}
    </FilterPopover>
  );
}

