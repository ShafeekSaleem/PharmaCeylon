"use client";

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
      label: `${b.value} (${b.count})`,
    })),
  ];
  const formOptions = [
    { value: "", label: "All forms" },
    ...(facets?.dosageForms ?? []).map((f) => ({
      value: f.value,
      label: `${f.value} (${f.count})`,
    })),
  ];
  const categoryOptions = [
    { value: "", label: "All categories" },
    ...(facets?.categories ?? []).map((c) => ({
      value: c.value,
      label: `${c.label} (${c.count})`,
    })),
  ];
  const tagOptions = [
    { value: "", label: "All tags" },
    ...(facets?.tags ?? []).map((t) => ({
      value: t.value,
      label: `${t.label} (${t.count})`,
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

  return (
    <>
      <div className={css.facetRow}>
        <InventoryFilterSelect
          label="Category"
          value={filters.categoryId}
          options={categoryOptions}
          onChange={(value) => onChange({ categoryId: value })}
          searchable
          searchPlaceholder="Search categories…"
        />
        <InventoryFilterSelect
          label="Brand"
          value={filters.brandName}
          options={brandOptions}
          onChange={(value) => onChange({ brandName: value })}
          searchable
          searchPlaceholder="Search brands…"
        />
        <InventoryFilterSelect
          label="Form"
          value={filters.dosageForm}
          options={formOptions}
          onChange={(value) => onChange({ dosageForm: value })}
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
        />
      </div>

      {active ? (
        <div className={css.activeFilter}>
          <div className={css.activeFilterMain}>
            <span className={css.activeFilterSummary}>
              Filtered catalog
              {resultCount != null ? (
                <>
                  {" "}
                  · {resultCount} result{resultCount === 1 ? "" : "s"}
                </>
              ) : null}
            </span>
            <div className={css.activeFilterPills}>
              {filters.exact ? <span className={css.filterPill}>Exact</span> : null}
              {filters.controlled ? (
                <span className={css.filterPill}>Controlled</span>
              ) : null}
              {stockLabel ? <span className={css.filterPill}>{stockLabel}</span> : null}
              {filters.brandName ? (
                <span className={css.filterPill}>Brand: {filters.brandName}</span>
              ) : null}
              {filters.dosageForm ? (
                <span className={css.filterPill}>Form: {filters.dosageForm}</span>
              ) : null}
              {filters.categoryId ? (
                <span className={css.filterPill}>
                  Category:{" "}
                  {facets?.categories.find((c) => c.value === filters.categoryId)
                    ?.label ?? "Selected"}
                </span>
              ) : null}
              {filters.tagId ? (
                <span className={css.filterPill}>
                  Tag:{" "}
                  {facets?.tags.find((t) => t.value === filters.tagId)?.label ??
                    "Selected"}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className={css.clearFilter}
            onClick={onClear}
            data-tooltip="Reset all catalog filters"
          >
            Clear filter
          </button>
        </div>
      ) : null}
    </>
  );
}
