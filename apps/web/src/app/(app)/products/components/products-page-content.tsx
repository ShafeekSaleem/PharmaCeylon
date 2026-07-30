"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconPackage,
  IconPlus,
  IconSearch,
  IconSettings,
} from "@/components/icons";
import {
  ActionButton,
  PageHeader,
  StatCard,
  StatGrid,
  type SortDir,
} from "@/components/ui";
import { getBranchId } from "@/lib/auth-session";
import { useAuth } from "@/lib/use-auth";
import {
  COLUMN_META,
  COLUMN_STORAGE_KEY,
  DEFAULT_VISIBLE,
  PRODUCT_STAT_PILLS,
} from "../constants";
import {
  EMPTY_PRODUCT_FILTERS,
  productFiltersAreActive,
  ProductsFilterPanel,
} from "../products-filter-panel";
import css from "../products.module.css";
import type { ColumnKey, Product, StatFilter } from "../types";
import { downloadProductsCsv, hasDeleteAccess, hasWriteAccess, loadVisibleColumns } from "../utils";
import { productDetailPath } from "../utils/product-routes";
import { useProductMeta } from "../hooks/use-product-meta";
import { useProductMetaMutations } from "../hooks/use-product-meta-mutations";
import { useProductMutations } from "../hooks/use-product-mutations";
import { useProductsList } from "../hooks/use-products-list";
import { useProductsUrlState } from "../hooks/use-products-url-state";
import { ConfirmDialog } from "./confirm-dialog";
import { ProductFormModal } from "./product-form-modal";
import { ProductMetaManagerModal } from "./product-meta-manager-modal";
import { ProductTable } from "./product-table";

export function ProductsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const canWrite = hasWriteAccess(user, branchId);
  const canDelete = hasDeleteAccess(user, branchId);
  const hasBranch = !!getBranchId();

  const {
    q,
    page,
    sortBy,
    sortDir,
    appliedFilters,
    setQ,
    setPage,
    setSort,
    setFilters,
    clearFilters,
    listQueryString,
  } = useProductsUrlState();

  const [search, setSearch] = useState(q);
  const [debouncedSearch, setDebouncedSearch] = useState(q);
  const [activeStatFilter, setActiveStatFilter] = useState<StatFilter | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(DEFAULT_VISIBLE);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [metaManagerOpen, setMetaManagerOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);

  const { categories, tags, refresh: refreshMeta } = useProductMeta();
  const metaMutations = useProductMetaMutations(refreshMeta);
  const list = useProductsList(page, debouncedSearch, appliedFilters, sortBy, sortDir);
  const mutations = useProductMutations(() => {
    list.reload();
    refreshMeta();
  });

  /* Legacy ?view=uuid → /products/[id] */
  useEffect(() => {
    const legacyView = searchParams.get("view");
    if (!legacyView) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("view");
    const returnQs = params.toString();
    const returnParam = returnQs ? { return: `/products?${returnQs}` } : undefined;
    router.replace(productDetailPath(legacyView, returnParam));
  }, [searchParams, router]);

  useEffect(() => {
    setSearch(q);
    setDebouncedSearch(q);
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      if (search !== q) setQ(search);
    }, 400);
    return () => clearTimeout(t);
  }, [search, q, setQ]);

  useEffect(() => {
    setVisibleColumns(loadVisibleColumns());
  }, []);

  useEffect(() => {
    if (!columnsOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (columnsRef.current && !columnsRef.current.contains(target)) {
        setColumnsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [columnsOpen]);

  const filtersActive = productFiltersAreActive(appliedFilters);

  const applyStatFilter = (filter: StatFilter) => {
    setActiveStatFilter(filter);
    if (filter === "all") {
      setFilters(EMPTY_PRODUCT_FILTERS);
    } else if (filter === "active") {
      setFilters({ ...EMPTY_PRODUCT_FILTERS, status: ["active"] });
    } else if (filter === "inactive") {
      setFilters({ ...EMPTY_PRODUCT_FILTERS, status: ["inactive"] });
    } else if (filter === "controlled") {
      setFilters({ ...EMPTY_PRODUCT_FILTERS, controlled: ["true"] });
    } else if (filter === "lowStock") {
      setFilters({ ...EMPTY_PRODUCT_FILTERS, lowStock: true });
    }
  };

  const handleClearFilters = () => {
    clearFilters();
    setActiveStatFilter(null);
  };

  const handleFiltersApply = (filters: typeof appliedFilters) => {
    setFilters(filters);
    setActiveStatFilter(null);
  };

  const toggleStatFilter = (filter: StatFilter) => {
    if (activeStatFilter === filter) {
      handleClearFilters();
      return;
    }
    applyStatFilter(filter);
  };

  const toggleColumn = (key: ColumnKey) => {
    const meta = COLUMN_META.find((c) => c.key === key);
    if (!meta?.hideable) return;
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      for (const c of COLUMN_META) {
        if (!c.hideable) next.add(c.key);
      }
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const handleServerSort = useCallback(
    (key: string, dir: SortDir) => setSort(key, dir),
    [setSort],
  );

  const openProduct = useCallback(
    (row: Product) => {
      const returnPath = listQueryString ? `/products?${listQueryString}` : "/products";
      router.push(
        productDetailPath(row.id, { return: returnPath }),
      );
    },
    [listQueryString, router],
  );

  const filterFacets = useMemo(
    () =>
      list.filterFacets
        ? {
            ...list.filterFacets,
            categories: list.filterFacets.categories ?? [],
            tags: list.filterFacets.tags ?? [],
          }
        : null,
    [list.filterFacets],
  );

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="Manage your pharmacy product catalog."
        actions={
          canWrite ? (
            <>
              <ActionButton variant="secondary" onClick={() => setMetaManagerOpen(true)}>
                Categories &amp; tags
              </ActionButton>
              <ActionButton icon={<IconPlus size={16} />} onClick={mutations.openCreate}>
                Add Product
              </ActionButton>
            </>
          ) : undefined
        }
      />

      <div className={css.mainCol}>
        <div className={css.statsSection}>
          <StatGrid columns={4} dense>
            <StatCard
              size="sm"
              title="Total Products"
              value={list.totalAll ?? "…"}
              subtitle="In catalog"
              icon={<IconPackage size={14} />}
              iconTone="primary"
              active={activeStatFilter === "all"}
              onClick={() => toggleStatFilter("all")}
            />
            <StatCard
              size="sm"
              title="Active Products"
              value={list.summaryFacets ? list.activeCount : "…"}
              subtitle="Sellable SKUs"
              icon={<IconCheck size={14} />}
              iconTone="success"
              active={activeStatFilter === "active"}
              onClick={() => toggleStatFilter("active")}
            />
            <StatCard
              size="sm"
              title="Controlled Substances"
              value={list.controlledCount}
              subtitle="Restricted items"
              icon={<IconAlertTriangle size={14} />}
              iconTone="warning"
              active={activeStatFilter === "controlled"}
              onClick={() => toggleStatFilter("controlled")}
            />
            <StatCard
              size="sm"
              title="Low Stock"
              value={list.lowStock ?? "—"}
              subtitle={hasBranch ? "Below reorder level" : "Select a branch"}
              icon={<IconActivity size={14} />}
              iconTone="danger"
              active={activeStatFilter === "lowStock"}
              onClick={() => hasBranch && toggleStatFilter("lowStock")}
            />
          </StatGrid>
        </div>

        <div className={css.toolbar}>
          <div className={css.toolbarGroup}>
            <ProductsFilterPanel
              facets={filterFacets}
              applied={appliedFilters}
              onApply={handleFiltersApply}
              hasBranch={hasBranch}
            />
            <div className={css.searchWrap}>
              <span className={css.searchIcon}>
                <IconSearch size={15} />
              </span>
              <input
                className={css.searchInput}
                type="search"
                placeholder="Search products…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className={css.statusPills} role="tablist" aria-label="Quick status filters">
              {PRODUCT_STAT_PILLS.map((pill) => {
                const disabled = pill.id === "lowStock" && !hasBranch;
                const active =
                  activeStatFilter === pill.id ||
                  (pill.id === "all" && activeStatFilter === null && !filtersActive);
                return (
                  <button
                    key={pill.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    disabled={disabled}
                    className={`${css.statusPill}${active ? ` ${css.statusPillActive}` : ""}`}
                    onClick={() => {
                      if (pill.id === "all") {
                        handleClearFilters();
                        setActiveStatFilter("all");
                        return;
                      }
                      toggleStatFilter(pill.id);
                    }}
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>
            <span className={css.showingCount}>
              Showing {list.total} product{list.total === 1 ? "" : "s"}
            </span>
            <div className={css.clearBtnSlot}>
              <button
                type="button"
                className={`${css.clearBtn} ${!filtersActive ? css.clearBtnHidden : ""}`}
                onClick={handleClearFilters}
                disabled={!filtersActive}
                tabIndex={filtersActive ? 0 : -1}
              >
                Clear filters
              </button>
            </div>
          </div>

          <div className={css.toolbarActions}>
            <button
              type="button"
              className={css.columnsBtn}
              onClick={() => downloadProductsCsv(list.products)}
              disabled={list.products.length === 0}
              data-tooltip={
                list.products.length === 0
                  ? "Nothing to export for the current filters"
                  : "Download current page as CSV"
              }
            >
              <IconDownload size={15} />
              Export
            </button>
            <div className={css.columnsWrap} ref={columnsRef}>
              <button
                type="button"
                className={css.columnsBtn}
                onClick={() => setColumnsOpen((o) => !o)}
                aria-expanded={columnsOpen}
              >
                <IconSettings size={15} />
                Columns
              </button>
              {columnsOpen && (
                <div className={css.columnsPopover}>
                  <div className={css.columnsPopoverTitle}>Show columns</div>
                  {COLUMN_META.filter((c) => c.hideable).map((col) => (
                    <label key={col.key} className={css.columnOption}>
                      <input
                        type="checkbox"
                        checked={visibleColumns.has(col.key)}
                        onChange={() => toggleColumn(col.key)}
                      />
                      {col.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {list.listError && (
          <Alert variant="error" className={css.listAlert}>
            {list.listError}
          </Alert>
        )}

        <ProductTable
          products={list.products}
          total={list.total}
          loading={list.loading}
          page={page}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
          canWrite={canWrite}
          canDelete={canDelete}
          onPageChange={setPage}
          onSort={handleServerSort}
          onRowClick={openProduct}
          onEdit={mutations.openEdit}
          onDelete={mutations.openDelete}
        />
      </div>

      <ProductMetaManagerModal
        open={metaManagerOpen}
        canWrite={canWrite}
        canDelete={canDelete}
        categories={categories}
        tags={tags}
        onClose={() => setMetaManagerOpen(false)}
        onRefresh={refreshMeta}
      />

      <ProductFormModal
        open={mutations.modalOpen}
        canWrite={canWrite}
        editingProduct={mutations.editingProduct}
        form={mutations.form}
        saving={mutations.saving}
        formError={mutations.formError}
        fieldErrors={mutations.fieldErrors}
        categories={categories}
        tags={tags}
        onClose={mutations.closeModal}
        onSave={() => void mutations.handleSave()}
        onFieldChange={mutations.updateField}
        onCreateCategory={canWrite ? metaMutations.createCategory : undefined}
        onCreateTag={canWrite ? metaMutations.createTag : undefined}
        onManageMeta={() => setMetaManagerOpen(true)}
        onAliasesChanged={
          mutations.editingProduct
            ? () => void mutations.refreshEditingProduct()
            : undefined
        }
      />

      <ConfirmDialog
        open={mutations.deleteTarget !== null}
        title="Delete product?"
        confirmLabel="Delete"
        loading={mutations.deleting}
        onCancel={() => {
          if (!mutations.deleting) mutations.setDeleteTarget(null);
        }}
        onConfirm={() => void mutations.handleDelete()}
      >
        {mutations.deleteError && (
          <Alert variant="error" className={css.modalAlert}>
            {mutations.deleteError}
          </Alert>
        )}
        <p>
          Permanently delete <strong>{mutations.deleteTarget?.name}</strong> (
          {mutations.deleteTarget?.sku})?
        </p>
        <p className={css.confirmDialogHint}>
          This cannot be undone. Deletion fails if the product is linked to inventory, sales, or
          purchase records. Mark inactive via Edit instead.
        </p>
      </ConfirmDialog>
    </div>
  );
}
