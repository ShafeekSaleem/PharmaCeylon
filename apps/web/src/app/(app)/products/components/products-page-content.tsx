"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconActivity,
  IconAlertTriangle,
  IconArchive,
  IconCheck,
  IconDownload,
  IconGrid,
  IconInfo,
  IconPackage,
  IconPause,
  IconPlus,
  IconSearch,
  IconSettings,
  IconStethoscope,
  IconTag,
  IconUpload,
  IconX,
} from "@/components/icons";
import {
  ActionButton,
  ActiveFilterBanner,
  PageHeader,
  StatCard,
  StatGrid,
  flattenCategoryTree,
  type SortDir,
} from "@/components/ui";
import { getBranchId } from "@/lib/auth-session";
import { useAuth } from "@/lib/use-auth";
import { hasPermission, usePermissions } from "@/lib/permissions";
import {
  COLUMN_META,
  COLUMN_STORAGE_KEY,
  DEFAULT_VISIBLE,
  PRODUCT_STAT_PILLS,
  REFERENCE_STAT_PILLS,
  type KpiIconTone,
} from "../constants";
import {
  CONTROLLED_LABELS,
  EMPTY_PRODUCT_FILTERS,
  productFiltersAreActive,
  ProductsFilterPanel,
  STATUS_LABELS,
} from "../products-filter-panel";
import css from "../products.module.css";
import type {
  BulkProductAction,
  ColumnKey,
  Product,
  ProductScope,
  StatFilter,
} from "../types";
import {
  downloadProductsCsv,
  downloadProductsExportCsv,
  hasWriteAccess,
  loadVisibleColumns,
} from "../utils";
import { productDetailPath } from "../utils/product-routes";
import { useProductMeta } from "../hooks/use-product-meta";
import { useProductMetaMutations } from "../hooks/use-product-meta-mutations";
import { useProductMutations } from "../hooks/use-product-mutations";
import {
  useProductBulkActions,
  type BulkExtras,
  type BulkTarget,
} from "../hooks/use-product-bulk-actions";
import { BulkOrganiseModal, type BulkOrganiseMode } from "./bulk-organise-modal";
import { CatalogTabs } from "./catalog-tabs";
import { buildProductFilterParams, useProductsList } from "../hooks/use-products-list";
import { useProductsUrlState } from "../hooks/use-products-url-state";
import { ConfirmDialog } from "./confirm-dialog";
import { NmraImportModal, type ImportMode } from "./nmra-import-modal";
import { ProductFormModal } from "./product-form-modal";
import { ProductTable } from "./product-table";

/** Same tone-pill mapping as the Catalog page's quick filter chips — keeps the "quick
 *  status" pill design consistent across pages instead of each page inventing its own. */
const STAT_PILL_TONE_CLASS: Record<KpiIconTone, string> = {
  primary: css.statusPillTeal,
  success: css.statusPillEmerald,
  info: css.statusPillSky,
  warning: css.statusPillAmber,
  danger: css.statusPillRose,
};

/** One-time explainer after the range-status migration, dismissed per browser. */
const RANGE_NOTICE_KEY = "pc-products-range-notice-dismissed-v1";

export function ProductsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const { permissionKeys } = usePermissions();
  const canWrite = hasWriteAccess(user, branchId);
  const canDeleteProduct = hasPermission(permissionKeys, ["products.delete"]);
  const canImportProducts = hasPermission(permissionKeys, ["products.import"]);
  const hasBranch = !!getBranchId();

  const {
    q,
    page,
    sortBy,
    sortDir,
    scope,
    appliedFilters,
    setQ,
    setPage,
    setSort,
    setScope,
    setFilters,
    clearFilters,
    listQueryString,
  } = useProductsUrlState();

  const [search, setSearch] = useState(q);
  const [debouncedSearch, setDebouncedSearch] = useState(q);
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(DEFAULT_VISIBLE);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importModal, setImportModal] = useState<ImportMode | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [rangeNoticeDismissed, setRangeNoticeDismissed] = useState(true);
  const columnsRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLDivElement>(null);

  const { categories, tags, refresh: refreshMeta } = useProductMeta();
  const metaMutations = useProductMetaMutations(refreshMeta);
  const list = useProductsList(
    page,
    debouncedSearch,
    appliedFilters,
    sortBy,
    sortDir,
    scope,
  );
  const mutations = useProductMutations(() => {
    list.reload();
    refreshMeta();
  });
  const [organiseMode, setOrganiseMode] = useState<BulkOrganiseMode | null>(null);
  const bulk = useProductBulkActions(() => {
    setSelectedIds(new Set());
    list.reload();
  });

  /* ?import=nmra opens the registry import — the Get started journey links straight here
     when a fresh pharmacy has no reference catalog to search yet. */
  useEffect(() => {
    if (searchParams.get("import") !== "nmra") return;
    setImportModal("nmra");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("import");
    const qs = params.toString();
    router.replace(qs ? `/products?${qs}` : "/products", { scroll: false });
  }, [searchParams, router]);

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
    try {
      setRangeNoticeDismissed(localStorage.getItem(RANGE_NOTICE_KEY) === "1");
    } catch {
      // Private mode / blocked storage — showing the notice again is harmless.
      setRangeNoticeDismissed(false);
    }
  }, []);

  /* A selection is only meaningful for the rows it was made against, so changing tab,
     page, search or filters clears it rather than acting on invisible products. */
  useEffect(() => {
    setSelectedIds(new Set());
  }, [scope, page, debouncedSearch, appliedFilters, sortBy, sortDir]);

  useEffect(() => {
    if (!columnsOpen && !exportOpen && !importMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (columnsOpen && columnsRef.current && !columnsRef.current.contains(target)) {
        setColumnsOpen(false);
      }
      if (exportOpen && exportRef.current && !exportRef.current.contains(target)) {
        setExportOpen(false);
      }
      if (importMenuOpen && importRef.current && !importRef.current.contains(target)) {
        setImportMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setColumnsOpen(false);
        setExportOpen(false);
        setImportMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [columnsOpen, exportOpen, importMenuOpen]);

  const dismissRangeNotice = () => {
    setRangeNoticeDismissed(true);
    try {
      localStorage.setItem(RANGE_NOTICE_KEY, "1");
    } catch {
      // Nothing to persist to — the notice simply returns next visit.
    }
  };

  const runBulk = (action: BulkProductAction) => {
    void bulk.run(action, { kind: "ids", productIds: [...selectedIds] });
  };

  /**
   * The selection as the bulk endpoints understand it. Category/tag actions reuse the same
   * two shapes as range/activate, so "everything matching these filters" works for them too.
   */
  const bulkTarget: BulkTarget = { kind: "ids", productIds: [...selectedIds] };

  const applyOrganise = (action: BulkProductAction, extras: BulkExtras) => {
    void bulk.run(action, bulkTarget, extras).then((result) => {
      if (result) {
        setOrganiseMode(null);
        setSelectedIds(new Set());
      }
    });
  };

  const runBulkOnAllMatching = (action: BulkProductAction) => {
    void bulk.run(action, {
      kind: "filter",
      params: buildProductFilterParams(
        debouncedSearch,
        appliedFilters,
        undefined,
        undefined,
        scope,
      ),
    });
  };

  const changeScope = (next: ProductScope) => {
    if (next === scope) return;
    setSelectedIds(new Set());
    setScope(next);
  };

  const handleExportPage = () => {
    setExportError(null);
    downloadProductsCsv(list.products);
    setExportOpen(false);
  };

  const handleExportAll = async () => {
    if (exportingAll || list.total === 0) return;
    setExportingAll(true);
    setExportError(null);
    setExportOpen(false);
    try {
      const params = buildProductFilterParams(
        debouncedSearch,
        appliedFilters,
        sortBy,
        sortDir,
        scope,
      );
      await downloadProductsExportCsv(params.toString());
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Failed to export products");
    } finally {
      setExportingAll(false);
    }
  };

  const filtersActive = productFiltersAreActive(appliedFilters);

  const activePill = useMemo((): StatFilter | null => {
    const f = appliedFilters;
    const onlyPillExtras =
      f.schedules.length === 0 &&
      f.formGroups.length === 0 &&
      f.registrationTypes.length === 0 &&
      f.brands.length === 0 &&
      f.tags.length === 0;
    if (!onlyPillExtras) return null;
    if (
      f.requiresPrescription &&
      !f.lowStock &&
      f.status.length === 0 &&
      f.controlled.length === 0
    ) {
      return "rx";
    }
    if (
      f.lowStock &&
      !f.requiresPrescription &&
      f.status.length === 0 &&
      f.controlled.length === 0
    ) {
      return "lowStock";
    }
    if (
      f.controlled.length === 1 &&
      f.controlled[0] === "true" &&
      !f.lowStock &&
      !f.requiresPrescription &&
      f.status.length === 0
    ) {
      return "controlled";
    }
    if (
      f.status.length === 1 &&
      f.status[0] === "active" &&
      !f.lowStock &&
      !f.requiresPrescription &&
      f.controlled.length === 0
    ) {
      return "active";
    }
    if (
      f.status.length === 1 &&
      f.status[0] === "inactive" &&
      !f.lowStock &&
      !f.requiresPrescription &&
      f.controlled.length === 0
    ) {
      return "inactive";
    }
    if (!filtersActive) return "all";
    return null;
  }, [appliedFilters, filtersActive]);

  const applyStatFilter = (filter: StatFilter) => {
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
    } else if (filter === "rx") {
      setFilters({ ...EMPTY_PRODUCT_FILTERS, requiresPrescription: true });
    }
  };

  const handleClearFilters = () => {
    clearFilters();
  };

  const handleFiltersApply = (filters: typeof appliedFilters) => {
    setFilters(filters);
  };

  const toggleStatFilter = (filter: StatFilter) => {
    if (activePill === filter) {
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
    (key: string, dir: SortDir | null) => setSort(key, dir),
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

  const activeFilterPills = useMemo(() => {
    const f = appliedFilters;
    const facetsData = list.filterFacets;
    const pills: { key: string; label: string }[] = [];

    if (f.commercialCategories.length) {
      const categoryOptions = flattenCategoryTree(facetsData?.commercialDepartments);
      for (const id of f.commercialCategories) {
        const label = categoryOptions.find((o) => o.value === id)?.label ?? id;
        pills.push({ key: `cat-${id}`, label: `Category: ${label}` });
      }
    }
    for (const code of f.schedules) {
      const label = facetsData?.schedules?.find((s) => s.value === code)?.label ?? code;
      pills.push({ key: `sch-${code}`, label: `Schedule: ${label}` });
    }
    for (const id of f.formGroups) {
      const label = facetsData?.formGroups?.find((g) => g.value === id)?.label ?? id;
      pills.push({ key: `fg-${id}`, label: `Form group: ${label}` });
    }
    for (const id of f.registrationTypes) {
      const label = facetsData?.registrationTypes?.find((r) => r.value === id)?.label ?? id;
      pills.push({ key: `rt-${id}`, label: `Registration type: ${label}` });
    }
    for (const brand of f.brands) {
      pills.push({ key: `brand-${brand}`, label: `Brand: ${brand}` });
    }
    for (const id of f.tags) {
      const label = facetsData?.tags?.find((t) => t.value === id)?.label ?? id;
      pills.push({ key: `tag-${id}`, label: `Tag: ${label}` });
    }
    for (const status of f.status) {
      pills.push({ key: `status-${status}`, label: STATUS_LABELS[status] ?? status });
    }
    for (const c of f.controlled) {
      pills.push({ key: `ctrl-${c}`, label: CONTROLLED_LABELS[c] ?? c });
    }
    if (f.lowStock) pills.push({ key: "lowStock", label: "Low stock" });
    if (f.requiresPrescription) {
      pills.push({ key: "rx", label: "Prescription required" });
    }

    return pills;
  }, [appliedFilters, list.filterFacets]);

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description={
          scope === "reference"
            ? "Look up any medicine on the NMRA register and add it to your products."
            : "The products your pharmacy sells."
        }
        actions={
          canWrite ? (
            <ActionButton icon={<IconPlus size={16} />} onClick={mutations.openCreate}>
              Add Product
            </ActionButton>
          ) : undefined
        }
      />

      <div className={css.mainCol}>
        {scope === "mine" && !rangeNoticeDismissed && (list.referenceCount ?? 0) > 0 && (
          <div className={css.rangeNotice} role="status">
            <span className={css.rangeNoticeIcon}>
              <IconInfo size={16} />
            </span>
            <div className={css.rangeNoticeBody}>
              <strong className={css.rangeNoticeTitle}>
                Your products and the NMRA register are now separate
              </strong>
              <p className={css.rangeNoticeText}>
                This page shows the{" "}
                {(list.rangedCount ?? 0).toLocaleString()} product
                {list.rangedCount === 1 ? "" : "s"} you actually sell. The{" "}
                {(list.referenceCount ?? 0).toLocaleString()} imported registry record
                {list.referenceCount === 1 ? " is" : "s are"} on the{" "}
                <strong>Reference catalog</strong> tab — still fully searchable, and you can
                tick any of them and choose <strong>Add to my products</strong>.
              </p>
            </div>
            <button
              type="button"
              className={css.rangeNoticeClose}
              onClick={dismissRangeNotice}
              aria-label="Dismiss this message"
              data-tooltip="Dismiss"
            >
              <IconX size={14} />
            </button>
          </div>
        )}

        <CatalogTabs
          active={scope === "reference" ? "reference" : "mine"}
          onScopeChange={changeScope}
          rangedCount={list.rangedCount}
          referenceCount={list.referenceCount}
        />

        <div className={css.statsSection}>
          {/* The reference tab drops the tiles that can't apply to a lookup-only record —
              active/inactive is the pharmacist's flag, and low stock needs stock. */}
          <StatGrid columns={scope === "reference" ? 3 : 5} dense>
            <StatCard
              size="sm"
              title={scope === "reference" ? "Reference Products" : "Total Products"}
              value={list.totalAll ?? "…"}
              subtitle={scope === "reference" ? "On the NMRA register" : "In your range"}
              icon={<IconPackage size={14} />}
              iconTone="primary"
              active={activePill === "all"}
              onClick={() => toggleStatFilter("all")}
            />
            {scope === "mine" && (
              <StatCard
                size="sm"
                title="Active Products"
                value={list.summaryFacets ? list.activeCount : "…"}
                subtitle="Sellable SKUs"
                icon={<IconCheck size={14} />}
                iconTone="success"
                active={activePill === "active"}
                onClick={() => toggleStatFilter("active")}
              />
            )}
            {scope === "mine" && (
              <StatCard
                size="sm"
                title="Inactive Products"
                value={list.summaryFacets ? list.inactiveCount : "…"}
                subtitle="Hidden from sell"
                icon={<IconPause size={14} />}
                iconTone="info"
                active={activePill === "inactive"}
                onClick={() => toggleStatFilter("inactive")}
              />
            )}
            <StatCard
              size="sm"
              title="Controlled Substances"
              value={list.controlledCount}
              subtitle="Restricted items"
              icon={<IconAlertTriangle size={14} />}
              iconTone="warning"
              active={activePill === "controlled"}
              onClick={() => toggleStatFilter("controlled")}
            />
            {scope === "reference" ? (
              <StatCard
                size="sm"
                title="Prescription Required"
                value={list.summaryFacets ? list.rxCount : "…"}
                subtitle="Needs a prescription"
                icon={<IconStethoscope size={14} />}
                iconTone="info"
                active={activePill === "rx"}
                onClick={() => toggleStatFilter("rx")}
              />
            ) : (
              <StatCard
                size="sm"
                title="Low Stock"
                value={list.lowStock ?? "—"}
                subtitle={hasBranch ? "Below reorder level" : "Select a branch"}
                icon={<IconActivity size={14} />}
                iconTone="danger"
                active={activePill === "lowStock"}
                onClick={() => hasBranch && toggleStatFilter("lowStock")}
              />
            )}
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
                aria-label="Search products"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className={css.statusPills} role="tablist" aria-label="Quick status filters">
              {(scope === "reference"
                ? REFERENCE_STAT_PILLS
                : PRODUCT_STAT_PILLS
              ).map((pill) => {
                const disabled = pill.id === "lowStock" && !hasBranch;
                const active = activePill === pill.id;
                return (
                  <button
                    key={pill.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    disabled={disabled}
                    className={`${css.statusPill} ${STAT_PILL_TONE_CLASS[pill.iconTone]}${
                      active ? ` ${css.statusPillActive}` : ""
                    }`}
                    onClick={() => toggleStatFilter(pill.id)}
                  >
                    {pill.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={css.toolbarActions}>
            {canWrite && (
              <div className={css.columnsWrap} ref={importRef}>
                <button
                  type="button"
                  className={css.columnsBtn}
                  onClick={() => {
                    setColumnsOpen(false);
                    setExportOpen(false);
                    setImportMenuOpen((o) => !o);
                  }}
                  aria-expanded={importMenuOpen}
                  aria-haspopup="menu"
                >
                  <IconUpload size={15} />
                  Import
                </button>
                {importMenuOpen && (
                  <div className={css.columnsPopover} role="menu">
                    <div className={css.columnsPopoverTitle}>Import products</div>
                    {canImportProducts && (
                      <button
                        type="button"
                        role="menuitem"
                        className={css.exportMenuItem}
                        onClick={() => {
                          setImportMenuOpen(false);
                          router.push("/products/import");
                        }}
                      >
                        <span className={css.exportMenuItemLabel}>My product list</span>
                        <span className={css.exportMenuItemHint}>
                          A spreadsheet from your old system, with stock
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className={css.exportMenuItem}
                      onClick={() => {
                        setImportMenuOpen(false);
                        setImportModal("nmra");
                      }}
                    >
                      <span className={css.exportMenuItemLabel}>NMRA register</span>
                      <span className={css.exportMenuItemHint}>
                        The official Sri Lankan medicines list
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={css.exportMenuItem}
                      onClick={() => {
                        setImportMenuOpen(false);
                        setImportModal("barcodes");
                      }}
                    >
                      <span className={css.exportMenuItemLabel}>Barcodes</span>
                      <span className={css.exportMenuItemHint}>
                        Add scannable barcodes to products you already have
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className={css.columnsWrap} ref={exportRef}>
              <button
                type="button"
                className={css.columnsBtn}
                onClick={() => {
                  setColumnsOpen(false);
                  setExportOpen((o) => !o);
                }}
                disabled={list.total === 0 || exportingAll}
                aria-expanded={exportOpen}
                aria-haspopup="menu"
                data-tooltip={
                  exportingAll
                    ? "Preparing full CSV…"
                    : list.total === 0
                      ? "Nothing to export for the current filters"
                      : "Export products as CSV"
                }
              >
                <IconDownload size={15} />
                {exportingAll ? "Exporting…" : "Export"}
              </button>
              {exportOpen && (
                <div className={css.columnsPopover} role="menu">
                  <div className={css.columnsPopoverTitle}>Export CSV</div>
                  <button
                    type="button"
                    role="menuitem"
                    className={css.exportMenuItem}
                    disabled={list.products.length === 0}
                    onClick={handleExportPage}
                  >
                    <span className={css.exportMenuItemLabel}>Export page</span>
                    <span className={css.exportMenuItemHint}>
                      Current page only ({list.products.length} row
                      {list.products.length === 1 ? "" : "s"})
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={css.exportMenuItem}
                    disabled={list.total === 0 || exportingAll}
                    onClick={() => void handleExportAll()}
                  >
                    <span className={css.exportMenuItemLabel}>Export all matching</span>
                    <span className={css.exportMenuItemHint}>
                      All filtered results ({list.total.toLocaleString()} product
                      {list.total === 1 ? "" : "s"})
                    </span>
                  </button>
                </div>
              )}
            </div>
            <div className={css.columnsWrap} ref={columnsRef}>
              <button
                type="button"
                className={css.columnsBtn}
                onClick={() => {
                  setExportOpen(false);
                  setColumnsOpen((o) => !o);
                }}
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
        {list.secondaryError && (
          <Alert variant="warning" className={css.listAlert}>
            {list.secondaryError}
          </Alert>
        )}
        {exportError && (
          <Alert variant="error" className={css.listAlert}>
            {exportError}
          </Alert>
        )}

        {bulk.error && (
          <Alert
            variant="error"
            className={css.listAlert}
            onClose={bulk.dismissError}
          >
            {bulk.error}
          </Alert>
        )}
        {bulk.notice && (
          <Alert
            variant="success"
            className={css.listAlert}
            onClose={bulk.dismissNotice}
          >
            {bulk.notice}
          </Alert>
        )}

        {/* Same shell as the filter banner above: both say "a subset of this page is in
            play, here is how to drop it". They used to look like two unrelated systems. */}
        {canWrite && selectedIds.size > 0 && (
          <div className={css.selectionBar} role="region" aria-label="Selected products">
            <div className={css.selectionMain}>
              <span className={css.selectionSummary}>
                {selectedIds.size.toLocaleString()} product
                {selectedIds.size === 1 ? "" : "s"} selected
              </span>
              {list.total > list.products.length && (
                <button
                  type="button"
                  className={css.selectionLink}
                  disabled={bulk.running !== null}
                  onClick={() =>
                    runBulkOnAllMatching(scope === "reference" ? "range" : "unrange")
                  }
                >
                  {scope === "reference" ? "Add" : "Move"} all{" "}
                  {list.total.toLocaleString()} matching instead
                </button>
              )}
            </div>

            <div className={css.selectionActions}>
              {scope === "reference" ? (
                <button
                  type="button"
                  className={css.selectionBtnPrimary}
                  disabled={bulk.running !== null}
                  onClick={() => runBulk("range")}
                >
                  <IconPlus size={14} />
                  {bulk.running === "range" ? "Adding…" : "Add to my products"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={css.selectionBtn}
                    disabled={bulk.running !== null}
                    onClick={() => runBulk("activate")}
                  >
                    <IconCheck size={14} />
                    {bulk.running === "activate" ? "Activating…" : "Activate"}
                  </button>
                  <button
                    type="button"
                    className={css.selectionBtn}
                    disabled={bulk.running !== null}
                    onClick={() => runBulk("deactivate")}
                  >
                    <IconPause size={14} />
                    {bulk.running === "deactivate" ? "Deactivating…" : "Deactivate"}
                  </button>
                  <button
                    type="button"
                    className={css.selectionBtn}
                    disabled={bulk.running !== null}
                    onClick={() => setOrganiseMode("category")}
                  >
                    <IconGrid size={14} />
                    Category
                  </button>
                  <button
                    type="button"
                    className={css.selectionBtn}
                    disabled={bulk.running !== null}
                    onClick={() => setOrganiseMode("tags")}
                  >
                    <IconTag size={14} />
                    Tags
                  </button>
                  <button
                    type="button"
                    className={css.selectionBtn}
                    disabled={bulk.running !== null}
                    onClick={() => runBulk("unrange")}
                    data-tooltip="Keep the record, but stop listing it as something you sell"
                  >
                    <IconArchive size={14} />
                    {bulk.running === "unrange" ? "Moving…" : "Move to reference"}
                  </button>
                </>
              )}
              <button
                type="button"
                className={css.selectionClear}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear selection
              </button>
            </div>
          </div>
        )}

        <ActiveFilterBanner
          active={filtersActive}
          summary={`Filtered products · ${list.total} product${list.total === 1 ? "" : "s"}`}
          pills={activeFilterPills}
          onClear={handleClearFilters}
          clearTooltip="Reset all product filters"
        />

        <ProductTable
          products={list.products}
          total={list.total}
          loading={list.loading}
          page={page}
          sortBy={sortBy}
          sortDir={sortDir}
          visibleColumns={visibleColumns}
          canWrite={canWrite}
          canDelete={canDeleteProduct}
          scope={scope}
          selectedIds={canWrite ? selectedIds : undefined}
          onSelectionChange={canWrite ? setSelectedIds : undefined}
          onPageChange={setPage}
          onSort={handleServerSort}
          onRowClick={openProduct}
          onEdit={mutations.openEdit}
          onDelete={mutations.openDelete}
        />
      </div>

      <NmraImportModal
        open={importModal !== null}
        mode={importModal ?? "nmra"}
        onClose={() => setImportModal(null)}
        onImported={() => {
          list.reload();
          refreshMeta();
        }}
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
        onManageMeta={() =>
          window.open("/products/categories", "_blank", "noopener,noreferrer")
        }
        onAliasesChanged={
          mutations.editingProduct
            ? () => void mutations.refreshEditingProduct()
            : undefined
        }
      />

      <BulkOrganiseModal
        mode={organiseMode}
        target={bulkTarget}
        selectionCount={selectedIds.size}
        categories={categories}
        tags={tags}
        running={bulk.running !== null}
        onPreview={bulk.preview}
        onApply={applyOrganise}
        onClose={() => setOrganiseMode(null)}
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
