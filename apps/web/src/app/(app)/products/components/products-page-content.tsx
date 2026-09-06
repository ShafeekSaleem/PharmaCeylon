"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconArchive,
  IconCheck,
  IconClipboardList,
  IconDownload,
  IconGrid,
  IconInfo,
  IconPause,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTag,
  IconUpload,
  IconX,
} from "@/components/icons";
import {
  ActionButton,
  ActiveFilterBanner,
  PageHeader,
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
  addReferenceProducts,
  previewReferenceAdd,
  exitRange,
  type ReferenceAddPreview,
} from "../api/catalog-tasks";
import { useCatalogTaskSummary } from "../hooks/use-catalog-task-summary";
import { CatalogIssueBanner } from "./catalog-issue-banner";
import { ReferenceAddReviewModal } from "./reference-add-review-modal";
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
import {
  BulkOrganiseModal,
  type BulkOrganiseMode,
} from "./bulk-organise-modal";
import { CatalogTabs } from "./catalog-tabs";
import {
  buildProductFilterParams,
  useProductsList,
} from "../hooks/use-products-list";
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

export function ProductsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const { permissionKeys } = usePermissions();
  const canWrite = hasWriteAccess(user, branchId);
  const canDeleteProduct = hasPermission(permissionKeys, ["products.delete"]);
  const canImportProducts = hasPermission(permissionKeys, ["products.import"]);
  const hasBranch = !!getBranchId();

  /*
   * Products and Search Catalog were two pages behind two permissions. Merging the second into
   * this page's Reference tab must not quietly take access away from anyone who had only
   * `catalog.view`, so the two scopes are gated separately rather than both riding on
   * `products.view` — see the layout guard, which admits either key.
   */
  const canViewMine = hasPermission(permissionKeys, ["products.view"]);
  const canViewReference = hasPermission(permissionKeys, [
    "catalog.view",
    "products.view",
  ]);
  const canManageCatalog = hasPermission(permissionKeys, [
    "products.view",
    "product_meta.view",
  ]);

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
  const [visibleColumns, setVisibleColumns] =
    useState<Set<ColumnKey>>(DEFAULT_VISIBLE);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importModal, setImportModal] = useState<ImportMode | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const columnsRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLDivElement>(null);

  const { categories, tags, refresh: refreshMeta } = useProductMeta();
  const metaMutations = useProductMetaMutations(refreshMeta);
  /* Set by the import completion screen's "View imported products". Not a panel filter — it
     scopes the list to one upload so an import's effect stays inspectable afterwards. */
  const importScopeId = searchParams.get("importId");

  const list = useProductsList(
    page,
    debouncedSearch,
    appliedFilters,
    sortBy,
    sortDir,
    scope,
    importScopeId,
  );
  const mutations = useProductMutations(() => {
    list.reload();
    refreshMeta();
  });
  const [organiseMode, setOrganiseMode] = useState<BulkOrganiseMode | null>(
    null,
  );
  const bulk = useProductBulkActions(() => {
    setSelectedIds(new Set());
    list.reload();
  });

  const { summary: taskSummary, reload: reloadTaskSummary } =
    useCatalogTaskSummary(canManageCatalog);
  const openTaskCount = taskSummary?.open ?? 0;

  /* Reference "Add to my products": preview first, apply second. */
  const [addPreview, setAddPreview] = useState<ReferenceAddPreview | null>(
    null,
  );
  const [addPending, setAddPending] = useState<string[]>([]);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [applyingAdd, setApplyingAdd] = useState(false);
  const [addedIds, setAddedIds] = useState<Set<string>>(() => new Set());
  const [referenceNotice, setReferenceNotice] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

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
    const returnParam = returnQs
      ? { return: `/products?${returnQs}` }
      : undefined;
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

  /* A selection is only meaningful for the rows it was made against, so changing tab,
     page, search or filters clears it rather than acting on invisible products. */
  useEffect(() => {
    setSelectedIds(new Set());
  }, [scope, page, debouncedSearch, appliedFilters, sortBy, sortDir]);

  useEffect(() => {
    if (!columnsOpen && !exportOpen && !importMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        columnsOpen &&
        columnsRef.current &&
        !columnsRef.current.contains(target)
      ) {
        setColumnsOpen(false);
      }
      if (
        exportOpen &&
        exportRef.current &&
        !exportRef.current.contains(target)
      ) {
        setExportOpen(false);
      }
      if (
        importMenuOpen &&
        importRef.current &&
        !importRef.current.contains(target)
      ) {
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
        importScopeId,
      ),
    });
  };

  /**
   * Add register rows to the pharmacy's range.
   *
   * Always previews first. When the server flags nothing, the add goes straight through — the
   * common case must stay one click. When it flags a duplicate identifier or a compliance
   * difference, the review modal opens instead, because those create a second record for one
   * real medicine and split its stock from then on.
   */
  async function startReferenceAdd(referenceProductIds: string[]) {
    if (referenceProductIds.length === 0) return;
    setReferenceError(null);
    setReferenceNotice(null);
    setAddingId(
      referenceProductIds.length === 1 ? referenceProductIds[0] : null,
    );
    try {
      const preview = await previewReferenceAdd(referenceProductIds);
      if (preview.needsReview > 0 || preview.blocked > 0) {
        setAddPending(referenceProductIds);
        setAddPreview(preview);
        return;
      }
      await applyReferenceAdd(referenceProductIds, false);
    } catch (err) {
      setReferenceError(
        err instanceof Error ? err.message : "Couldn't add those products",
      );
    } finally {
      setAddingId(null);
    }
  }

  async function applyReferenceAdd(
    referenceProductIds: string[],
    acknowledge: boolean,
  ) {
    setApplyingAdd(true);
    setReferenceError(null);
    try {
      const result = await addReferenceProducts(
        referenceProductIds,
        acknowledge,
      );
      setAddedIds((prev) => new Set([...prev, ...result.added]));
      const parts = [
        `${result.added.length.toLocaleString()} product${result.added.length === 1 ? "" : "s"} added to your range`,
      ];
      if (result.held.length > 0) {
        parts.push(
          `${result.held.length.toLocaleString()} skipped — ${result.held[0].reason}`,
        );
      }
      setReferenceNotice(parts.join(". "));
      setAddPreview(null);
      setAddPending([]);
      setSelectedIds(new Set());
      list.reload();
      reloadTaskSummary();
    } catch (err) {
      setReferenceError(
        err instanceof Error ? err.message : "Couldn't add those products",
      );
    } finally {
      setApplyingAdd(false);
    }
  }

  /**
   * Take products out of the range. Goes through the policy endpoint rather than the plain
   * bulk `unrange`, so a locally created product is deactivated instead of being filed into
   * the NMRA reference catalog, and anything still holding stock is refused with a reason.
   */
  async function runRangeExit(productIds: string[]) {
    if (productIds.length === 0) return;
    setReferenceError(null);
    setReferenceNotice(null);
    try {
      const result = await exitRange(productIds);
      const parts: string[] = [];
      if (result.unranged.length > 0) {
        parts.push(
          `${result.unranged.length.toLocaleString()} moved back to the reference catalog`,
        );
      }
      if (result.deactivated.length > 0) {
        parts.push(`${result.deactivated.length.toLocaleString()} deactivated`);
      }
      if (result.blocked.length > 0) {
        parts.push(`${result.blocked.length.toLocaleString()} left alone`);
      }
      setReferenceNotice(
        [
          parts.join(", ") || "Nothing changed",
          ...result.notes,
          result.blocked[0]?.reason,
        ]
          .filter(Boolean)
          .join(". "),
      );
      setSelectedIds(new Set());
      list.reload();
    } catch (err) {
      setReferenceError(
        err instanceof Error ? err.message : "Couldn't update those products",
      );
    }
  }

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
        importScopeId,
      );
      await downloadProductsExportCsv(params.toString());
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "Failed to export products",
      );
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
      const returnPath = listQueryString
        ? `/products?${listQueryString}`
        : "/products";
      router.push(productDetailPath(row.id, { return: returnPath }));
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
      const categoryOptions = flattenCategoryTree(
        facetsData?.commercialDepartments,
      );
      for (const id of f.commercialCategories) {
        const label = categoryOptions.find((o) => o.value === id)?.label ?? id;
        pills.push({ key: `cat-${id}`, label: `Category: ${label}` });
      }
    }
    for (const code of f.schedules) {
      const label =
        facetsData?.schedules?.find((s) => s.value === code)?.label ?? code;
      pills.push({ key: `sch-${code}`, label: `Schedule: ${label}` });
    }
    for (const id of f.formGroups) {
      const label =
        facetsData?.formGroups?.find((g) => g.value === id)?.label ?? id;
      pills.push({ key: `fg-${id}`, label: `Form group: ${label}` });
    }
    for (const id of f.registrationTypes) {
      const label =
        facetsData?.registrationTypes?.find((r) => r.value === id)?.label ?? id;
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
      pills.push({
        key: `status-${status}`,
        label: STATUS_LABELS[status] ?? status,
      });
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
          <>
            {/* Secondary, and quieter than Add Product on purpose: administering the catalog
                is occasional work, adding a product is the daily one. The badge is the only
                thing that raises its voice, and only when there is something to raise it about. */}
            {canManageCatalog && (
              <Link
                href="/products/manage"
                className={css.manageCatalogBtn}
                aria-label={
                  openTaskCount > 0
                    ? `Manage catalog, ${openTaskCount.toLocaleString()} tasks need review`
                    : "Manage catalog"
                }
              >
                <IconClipboardList size={15} aria-hidden />
                Manage catalog
                {openTaskCount > 0 && (
                  <span className={css.manageCatalogBadge} aria-hidden>
                    {openTaskCount.toLocaleString()}
                  </span>
                )}
              </Link>
            )}
            {canWrite && scope === "mine" && (
              <ActionButton
                icon={<IconPlus size={16} />}
                onClick={mutations.openCreate}
              >
                Add Product
              </ActionButton>
            )}
          </>
        }
      />

      <div className={css.mainCol}>
        <CatalogTabs
          active={scope === "reference" ? "reference" : "mine"}
          onScopeChange={changeScope}
          rangedCount={list.rangedCount}
          referenceCount={list.referenceCount}
          canViewMine={canViewMine}
          canViewReference={canViewReference}
        />

        {/* Only when there is work. See CatalogIssueBanner for why this replaced five tiles. */}
        {scope === "mine" && canManageCatalog && (
          <CatalogIssueBanner summary={taskSummary} />
        )}

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
            <div
              className={css.statusPills}
              role="tablist"
              aria-label="Quick status filters"
            >
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
                    <div className={css.columnsPopoverTitle}>
                      Import products
                    </div>
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
                        <span className={css.exportMenuItemLabel}>
                          My product list
                        </span>
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
                      <span className={css.exportMenuItemLabel}>
                        NMRA register
                      </span>
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
                    <span className={css.exportMenuItemLabel}>
                      Export all matching
                    </span>
                    <span className={css.exportMenuItemHint}>
                      All filtered results ({list.total.toLocaleString()}{" "}
                      product
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

        {referenceError && (
          <Alert
            variant="error"
            className={css.listAlert}
            onClose={() => setReferenceError(null)}
          >
            {referenceError}
          </Alert>
        )}
        {referenceNotice && (
          <Alert
            variant="success"
            className={css.listAlert}
            onClose={() => setReferenceNotice(null)}
          >
            {referenceNotice}
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
          <div
            className={css.selectionBar}
            role="region"
            aria-label="Selected products"
          >
            <div className={css.selectionMain}>
              <span className={css.selectionSummary}>
                {selectedIds.size.toLocaleString()} product
                {selectedIds.size === 1 ? "" : "s"} selected
              </span>
              {/* Only offered for the register tab. "Deactivate all 4,000 matching" is not an
                  action anyone means to take, and the range-exit policy is per-product by
                  design — it needs each product's stock and history to decide. */}
              {scope === "reference" && list.total > list.products.length && (
                <button
                  type="button"
                  className={css.selectionLink}
                  disabled={bulk.running !== null}
                  onClick={() => runBulkOnAllMatching("range")}
                >
                  Add all {list.total.toLocaleString()} matching instead
                </button>
              )}
            </div>

            <div className={css.selectionActions}>
              {scope === "reference" ? (
                <button
                  type="button"
                  className={css.selectionBtnPrimary}
                  disabled={applyingAdd}
                  onClick={() => void startReferenceAdd([...selectedIds])}
                >
                  <IconPlus size={14} />
                  {applyingAdd ? "Adding…" : "Add to my products"}
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
                    {bulk.running === "deactivate"
                      ? "Deactivating…"
                      : "Deactivate"}
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
                    onClick={() => void runRangeExit([...selectedIds])}
                    data-tooltip="Register medicines go back to the reference catalog; your own products are deactivated instead"
                  >
                    <IconArchive size={14} />
                    Stop selling
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
          active={filtersActive || Boolean(importScopeId)}
          summary={
            importScopeId
              ? `Products from one import · ${list.total.toLocaleString()} product${list.total === 1 ? "" : "s"}`
              : `Filtered products · ${list.total} product${list.total === 1 ? "" : "s"}`
          }
          pills={activeFilterPills}
          onClear={() => {
            handleClearFilters();
            if (importScopeId) {
              const params = new URLSearchParams(searchParams.toString());
              params.delete("importId");
              const qs = params.toString();
              router.replace(qs ? `/products?${qs}` : "/products", {
                scroll: false,
              });
            }
          }}
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
          onAddReference={
            scope === "reference"
              ? (row) => void startReferenceAdd([row.id])
              : undefined
          }
          addedReferenceIds={addedIds}
          addingReferenceId={addingId}
        />
      </div>

      <ReferenceAddReviewModal
        open={addPreview !== null}
        preview={addPreview}
        applying={applyingAdd}
        onCancel={() => {
          setAddPreview(null);
          setAddPending([]);
        }}
        onConfirm={() => void applyReferenceAdd(addPending, true)}
      />

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
          window.open(
            "/products/manage?section=categories",
            "_blank",
            "noopener,noreferrer",
          )
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
          This cannot be undone. Deletion fails if the product is linked to
          inventory, sales, or purchase records. Mark inactive via Edit instead.
        </p>
      </ConfirmDialog>
    </div>
  );
}
