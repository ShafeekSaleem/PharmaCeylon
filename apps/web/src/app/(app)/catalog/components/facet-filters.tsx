"use client";

import { ActiveFilterBanner, flattenCategoryTree, TreeMultiSelect, type FilterPill } from "@/components/ui";
import { InventoryFilterSelect } from "../../inventory/components/inventory-filter-select";
import css from "../catalog.module.css";
import type { CatalogFacets, CatalogFilters } from "../types";
import { hasActiveFilters } from "../utils";

type Props = {
  filters: CatalogFilters;
  facets: CatalogFacets | null;
  resultCount?: number | null;
  onChange: (patch: Partial<CatalogFilters>) => void;
  onClear: () => void;
};

export function FacetFilters({
  filters,
  facets,
  resultCount,
  onChange,
  onClear,
}: Props) {
  const brandOptions = [
    { value: "", label: "All brands" },
    ...(facets?.brands ?? []).map((b) => ({
      value: b.value,
      label: b.value,
      count: b.count,
    })),
  ];
  const formOptions = [
    { value: "", label: "All forms" },
    ...(facets?.dosageForms ?? []).map((f) => ({
      value: f.value,
      label: f.value,
      count: f.count,
    })),
  ];
  const categoryTreeOptions = flattenCategoryTree(facets?.commercialDepartments);
  const tagOptions = [
    { value: "", label: "All tags" },
    ...(facets?.tags ?? []).map((t) => ({
      value: t.value,
      label: t.label,
      count: t.count,
    })),
  ];
  const stockOptions = [
    { value: "", label: "All stock" },
    { value: "in", label: "In stock" },
    { value: "low", label: "Low stock" },
    { value: "out", label: "Out of stock" },
  ];

  const active = hasActiveFilters(filters);
  const stockLabel =
    filters.stockStatus === "in"
      ? "In stock"
      : filters.stockStatus === "low"
        ? "Low stock"
        : filters.stockStatus === "out"
          ? "Out of stock"
          : filters.inStock
            ? "In stock"
            : null;

  const pills: FilterPill[] = [];
  if (filters.exact) pills.push({ key: "exact", label: "Exact" });
  if (filters.controlled) pills.push({ key: "controlled", label: "Controlled" });
  if (stockLabel) pills.push({ key: "stock", label: stockLabel });
  if (filters.brandName) pills.push({ key: "brand", label: `Brand: ${filters.brandName}` });
  if (filters.dosageForm) pills.push({ key: "form", label: `Form: ${filters.dosageForm}` });
  for (const id of filters.commercialCategoryIds) {
    pills.push({
      key: `cat-${id}`,
      label: `Category: ${categoryTreeOptions.find((c) => c.value === id)?.label ?? "Selected"}`,
    });
  }
  if (filters.tagId) {
    pills.push({
      key: "tag",
      label: `Tag: ${facets?.tags.find((t) => t.value === filters.tagId)?.label ?? "Selected"}`,
    });
  }

  return (
    <>
      <div className={css.facetRow}>
        <TreeMultiSelect
          label="Category"
          options={categoryTreeOptions}
          selected={filters.commercialCategoryIds}
          onChange={(commercialCategoryIds) => onChange({ commercialCategoryIds })}
          searchPlaceholder="Search categories…"
          className={css.facetFieldWide}
        />
        <InventoryFilterSelect
          label="Brand"
          value={filters.brandName}
          options={brandOptions}
          onChange={(value) => onChange({ brandName: value })}
          searchable
          searchPlaceholder="Search brands…"
          className={css.facetFieldWide}
        />
        <InventoryFilterSelect
          label="Form"
          value={filters.dosageForm}
          options={formOptions}
          onChange={(value) => onChange({ dosageForm: value })}
          className={css.facetFieldWide}
        />
        <InventoryFilterSelect
          label="Stock"
          value={filters.stockStatus}
          options={stockOptions}
          onChange={(value) =>
            onChange({
              stockStatus: value as CatalogFilters["stockStatus"],
              inStock: value === "in",
            })
          }
        />
        <InventoryFilterSelect
          label="Tags"
          value={filters.tagId}
          options={tagOptions}
          onChange={(value) => onChange({ tagId: value })}
          searchable
          searchPlaceholder="Search tags…"
          className={css.facetFieldWide}
        />
      </div>

      <ActiveFilterBanner
        active={active}
        summary={`Filtered catalog${resultCount != null ? ` · ${resultCount} result${resultCount === 1 ? "" : "s"}` : ""}`}
        pills={pills}
        onClear={onClear}
        clearTooltip="Reset all catalog filters"
      />
    </>
  );
}
