"use client";

import {
  buildCategoryTree,
  FilterPopover,
  FilterRow,
  flattenCategoryTree,
  TreeMultiSelect,
} from "@/components/ui";

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

type FlatOption = { value: string; label: string; count?: number };

/** A raw COMMERCIAL category row (from `/products/categories`) — nested into a tree here
 *  via `buildCategoryTree`, matching the Products page's Category filter exactly. */
type CategoryRow = { id: string; name: string; parentCategoryId: string | null; productCount?: number };

type FilterOptions = {
  categories: CategoryRow[];
  brands: FlatOption[];
  tags: FlatOption[];
  dosageForms: FlatOption[];
};

type Props = {
  value: InventoryCatalogFilters;
  options: FilterOptions;
  onChange: (filters: InventoryCatalogFilters) => void;
};

export function inventoryCatalogFiltersAreActive(filters: InventoryCatalogFilters) {
  return Object.values(filters).some((values) => values.length > 0);
}

/**
 * Same "Filter" popover as the Products page (shared `FilterPopover`/`FilterRow`/
 * `TreeMultiSelect`), reused here instead of Inventory inventing its own catalog-filter UI.
 * Category is the same hierarchical COMMERCIAL department tree as Products.
 */
export function InventoryFilterPanel({ value, options, onChange }: Props) {
  const active = inventoryCatalogFiltersAreActive(value);

  const patch = (key: keyof InventoryCatalogFilters, next: string[]) => {
    onChange({ ...value, [key]: next });
  };

  const categoryTree = buildCategoryTree(options.categories, (row, children) => ({
    id: row.id,
    label: row.name,
    canonicalKey: null,
    count: row.productCount ?? 0,
    children,
  }));
  const categoryOptions = flattenCategoryTree(categoryTree);

  return (
    <FilterPopover active={active} panelAriaLabel="Filter inventory">
      <FilterRow
        label="Category"
        hasSelection={value.categories.length > 0}
        onClear={() => patch("categories", [])}
      >
        <TreeMultiSelect
          options={categoryOptions}
          selected={value.categories}
          onChange={(next) => patch("categories", next)}
          searchPlaceholder="Search categories…"
          menuPlacement="right"
        />
      </FilterRow>

      <FilterRow
        label="Brand"
        hasSelection={value.brands.length > 0}
        onClear={() => patch("brands", [])}
      >
        <TreeMultiSelect
          options={options.brands}
          selected={value.brands}
          onChange={(next) => patch("brands", next)}
          searchPlaceholder="Search brands…"
          menuPlacement="right"
        />
      </FilterRow>

      <FilterRow label="Tags" hasSelection={value.tags.length > 0} onClear={() => patch("tags", [])}>
        <TreeMultiSelect
          options={options.tags}
          selected={value.tags}
          onChange={(next) => patch("tags", next)}
          searchPlaceholder="Search tags…"
          menuPlacement="right"
        />
      </FilterRow>

      <FilterRow
        label="Dosage form"
        hasSelection={value.dosageForms.length > 0}
        onClear={() => patch("dosageForms", [])}
      >
        <TreeMultiSelect
          options={options.dosageForms}
          selected={value.dosageForms}
          onChange={(next) => patch("dosageForms", next)}
          searchPlaceholder="Search forms…"
          menuPlacement="right"
        />
      </FilterRow>
    </FilterPopover>
  );
}
