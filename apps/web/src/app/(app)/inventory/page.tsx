"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconCalendar,
  IconDownload,
  IconLock,
  IconPackage,
  IconPlus,
  IconSearch,
} from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import {
  ActionButton,
  ActiveFilterBanner,
  PageHeader,
  StatCard,
  type FilterPill,
  type SortDir,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useProductMeta } from "../products/hooks/use-product-meta";
import { AdjustmentModal } from "./components/adjustment-modal";
import { InventoryFilterSelect } from "./components/inventory-filter-select";
import {
  EMPTY_INVENTORY_CATALOG_FILTERS,
  InventoryFilterPanel,
  inventoryCatalogFiltersAreActive,
  type InventoryCatalogFilters,
} from "./components/inventory-filter-panel";
import { InventorySubnav } from "./components/inventory-subnav";
import { ProductStockSheet } from "./components/product-stock-sheet";
import { StockTable, type StockSortKey } from "./components/stock-table";
import { PAGE_SIZE } from "./constants";
import { useInventoryAccess } from "./hooks/use-inventory-access";
import { useInventoryStock, useInventorySummary } from "./hooks/use-inventory-stock";
import css from "./inventory.module.css";
import type { StockAttention, StockRow, StockView } from "./types";
import { formatCompactMoney, stockStatusLabel } from "./utils";

/** "Show" filter: the attention buckets plus products with no batches at this branch. */
type ShowFilter = "all" | StockAttention | "no_batches";

const SHOW_OPTIONS: { value: ShowFilter; label: string }[] = [
  { value: "all", label: "All products" },
  { value: "expired", label: "Expired stock" },
  { value: "near_expiry", label: "Expiring soon" },
  { value: "quarantined", label: "Quarantined stock" },
  { value: "reserved", label: "Reserved for transfers" },
  { value: "expiry_review", label: "Expiry date to confirm" },
  { value: "no_batches", label: "No batches here" },
];

const VIEW_LABELS: Record<string, string> = { ok: "Healthy", low: "Low stock", out: "Out of stock" };
const PRODUCT_TYPE_LABELS: Record<string, string> = {
  controlled: "Controlled",
  regular: "Non-controlled",
};

function parseShow(value: string | null): ShowFilter {
  return SHOW_OPTIONS.some((option) => option.value === value) ? (value as ShowFilter) : "all";
}

function StockOverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const access = useInventoryAccess();
  const canAdjust = access.canAdjustIn || access.canWriteOff;
  const productMeta = useProductMeta();

  const productIdFilter = searchParams.get("productId");
  const initialView = searchParams.get("view");
  const [view, setView] = useState<Exclude<StockView, "expiring">>(
    initialView === "ok" || initialView === "low" || initialView === "out" ? initialView : "all",
  );
  const [show, setShow] = useState<ShowFilter>(() =>
    initialView === "expiring" ? "near_expiry" : parseShow(searchParams.get("show")),
  );
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: StockSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const initialControlled = searchParams.get("controlled");
  const [productFilter, setProductFilter] = useState(
    initialControlled === "controlled" || initialControlled === "regular" ? initialControlled : "all",
  );
  const [catalogFilters, setCatalogFilters] = useState<InventoryCatalogFilters>(
    EMPTY_INVENTORY_CATALOG_FILTERS,
  );
  const [facetBrands, setFacetBrands] = useState<{ value: string; label: string; count: number }[]>([]);
  const [facetForms, setFacetForms] = useState<{ value: string; label: string; count: number }[]>([]);
  const [adjustmentOpen, setAdjustmentOpen] = useState(searchParams.get("openAdjustment") === "1");
  const [adjustmentContext, setAdjustmentContext] = useState<{ productId: string; batchId: string }>({
    productId: searchParams.get("productId") ?? "",
    batchId: searchParams.get("batchId") ?? "",
  });
  const [sheetProductId, setSheetProductId] = useState<string | null>(searchParams.get("stock"));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("openAdjustment") !== "1") return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("openAdjustment");
    next.delete("batchId");
    const qs = next.toString();
    router.replace(qs ? `/inventory?${qs}` : "/inventory");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    apiJson<{
      brands: { value: string; count: number }[];
      dosageForms: { value: string; count: number }[];
    }>("/catalog/facets")
      .then((facets) => {
        setFacetBrands((facets.brands ?? []).map((b) => ({ value: b.value, label: b.value, count: b.count })));
        setFacetForms(
          (facets.dosageForms ?? []).map((f) => ({ value: f.value, label: f.value, count: f.count })),
        );
      })
      .catch(() => {
        setFacetBrands([]);
        setFacetForms([]);
      });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [view, show, debouncedQ, productIdFilter, productFilter, catalogFilters, sort]);

  const stock = useInventoryStock({
    status: view,
    q: debouncedQ,
    page,
    pageSize: PAGE_SIZE,
    productId: productIdFilter,
    controlled: productFilter === "controlled" || productFilter === "regular" ? productFilter : "all",
    batchFilter: show === "no_batches" ? "no_batches" : "all",
    attention: show !== "all" && show !== "no_batches" ? show : null,
    sort: sort.key,
    dir: sort.dir,
    catalogFilters,
  });
  const { summary, reload: reloadSummary } = useInventorySummary("this_month");

  const refresh = useCallback(
    (message?: string) => {
      if (message) setNotice(message);
      void stock.reload();
      void reloadSummary();
    },
    [stock, reloadSummary],
  );

  const openAdjustment = useCallback((productId = "", batchId = "") => {
    setAdjustmentContext({ productId, batchId });
    setAdjustmentOpen(true);
  }, []);

  const openSheet = useCallback((row: StockRow) => setSheetProductId(row.productId), []);
  const adjustRow = useCallback((row: StockRow) => openAdjustment(row.productId), [openAdjustment]);

  const catalogFilterOptions = useMemo(() => {
    const byLabel = (left: { label: string }, right: { label: string }) =>
      left.label.localeCompare(right.label);
    return {
      categories: productMeta.categories,
      tags: productMeta.tags
        .map((tag) => ({ value: tag.id, label: tag.name, count: tag.productCount ?? 0 }))
        .sort(byLabel),
      brands: [...facetBrands].sort(byLabel),
      dosageForms: [...facetForms].sort(byLabel),
    };
  }, [productMeta.categories, productMeta.tags, facetBrands, facetForms]);

  const clearFilters = () => {
    setView("all");
    setShow("all");
    setProductFilter("all");
    setCatalogFilters(EMPTY_INVENTORY_CATALOG_FILTERS);
    setSearch("");
    if (productIdFilter) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("productId");
      const qs = next.toString();
      router.replace(qs ? `/inventory?${qs}` : "/inventory");
    }
  };

  const toggleView = (next: Exclude<StockView, "expiring">) => setView((prev) => (prev === next ? "all" : next));
  const toggleShow = (next: ShowFilter) => setShow((prev) => (prev === next ? "all" : next));

  const exportRows = () => {
    const escapeCsv = (value: string | number | null) => {
      const text = String(value ?? "");
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const header = [
      "Product",
      "SKU",
      "Barcode",
      "Available",
      "On hand",
      "Quarantined",
      "Reserved",
      "Expired (not yet quarantined)",
      "Stock status",
      "Reorder level",
      "Batches",
      "Last movement",
    ];
    const csv = [
      header,
      ...stock.rows.map((row) => [
        row.product.name,
        row.product.sku,
        row.product.barcode,
        row.availableQty,
        row.qtyOnHand,
        row.quarantinedQty,
        row.reservedQty,
        row.expiredQty,
        stockStatusLabel(row.stockStatus),
        row.product.reorderLevel,
        row.batchCount,
        row.lastMovementAt,
      ]),
    ]
      .map((line) => line.map(escapeCsv).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const filtersActive =
    view !== "all" ||
    show !== "all" ||
    productFilter !== "all" ||
    !!productIdFilter ||
    debouncedQ.trim().length > 0 ||
    inventoryCatalogFiltersAreActive(catalogFilters);

  const activeFilterPills: FilterPill[] = [
    ...(view !== "all" ? [{ key: "view", label: `Stock: ${VIEW_LABELS[view] ?? view}` }] : []),
    ...(show !== "all"
      ? [{ key: "show", label: SHOW_OPTIONS.find((option) => option.value === show)?.label ?? show }]
      : []),
    ...(productFilter !== "all"
      ? [{ key: "productType", label: PRODUCT_TYPE_LABELS[productFilter] ?? productFilter }]
      : []),
    ...(debouncedQ.trim() ? [{ key: "q", label: `Search: ${debouncedQ.trim()}` }] : []),
    ...catalogFilters.categories.map((id) => ({
      key: `cat-${id}`,
      label: `Category: ${productMeta.categories.find((c) => c.id === id)?.name ?? "Selected"}`,
    })),
    ...catalogFilters.brands.map((brand) => ({ key: `brand-${brand}`, label: `Brand: ${brand}` })),
    ...catalogFilters.tags.map((id) => ({
      key: `tag-${id}`,
      label: `Tag: ${productMeta.tags.find((t) => t.id === id)?.name ?? "Selected"}`,
    })),
    ...catalogFilters.dosageForms.map((form) => ({ key: `form-${form}`, label: `Form: ${form}` })),
  ];

  const heldUnits = (summary?.quarantinedUnits ?? 0) + (summary?.reservedUnits ?? 0);

  return (
    <>
      <ProductContextBanner />
      <PageHeader
        subtitleOnly
        floatingActions
        description="What you can sell or move right now at the selected branch — and what is held back, promised or expiring."
        actions={
          canAdjust ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Add stock or write stock off on a batch"
              onClick={() => openAdjustment()}
            >
              New adjustment
            </ActionButton>
          ) : null
        }
      />

      <InventorySubnav />

      {notice && <Alert variant="success">{notice}</Alert>}

      {!stock.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to view inventory for that location.
        </div>
      )}

      {stock.hasBranch && summary && summary.expired > 0 && (
        <Alert variant="warning">
          <strong>{summary.expired}</strong> {summary.expired === 1 ? "batch is" : "batches are"} past
          expiry with {summary.expiredUnits.toLocaleString()} units still counted as sellable.{" "}
          <Link href="/inventory/batches?expired=1">Review expired batches</Link>
        </Alert>
      )}
      {stock.hasBranch && summary && summary.expiryReview > 0 && (
        <Alert variant="info">
          <strong>{summary.expiryReview}</strong> imported{" "}
          {summary.expiryReview === 1 ? "batch needs" : "batches need"} a real expiry date before{" "}
          {summary.expiryReview === 1 ? "it" : "they"} can be sold.{" "}
          <Link href="/inventory/batches?needsExpiryReview=true">Confirm expiry dates</Link>
        </Alert>
      )}

      {stock.hasBranch && (
        <div className={css.kpiRow}>
          <StatCard
            size="sm"
            title="Available"
            value={summary ? summary.availableUnits.toLocaleString() : "—"}
            subtitle={
              summary
                ? `${summary.totalUnits.toLocaleString()} on hand${
                    summary.stockValue != null ? ` · ${formatCompactMoney(summary.stockValue)} at cost` : ""
                  }`
                : undefined
            }
            icon={<IconPackage size={16} />}
            iconTone="primary"
            onClick={clearFilters}
            active={!filtersActive}
          />
          <StatCard
            size="sm"
            title="Low stock"
            value={summary?.lowStock ?? "—"}
            subtitle="At or below reorder level"
            icon={<IconAlertTriangle size={16} />}
            iconTone="warning"
            onClick={() => toggleView("low")}
            active={view === "low"}
          />
          <StatCard
            size="sm"
            title="Out of stock"
            value={summary?.outOfStock ?? "—"}
            subtitle="Nothing available to sell"
            icon={<IconAlertTriangle size={16} />}
            iconTone="danger"
            onClick={() => toggleView("out")}
            active={view === "out"}
          />
          <StatCard
            size="sm"
            title="Expiring soon"
            value={summary?.nearExpiryProducts ?? "—"}
            subtitle={
              summary
                ? `${summary.nearExpiry} ${summary.nearExpiry === 1 ? "batch" : "batches"} within ${summary.expiryWarningDays} days`
                : undefined
            }
            icon={<IconCalendar size={16} />}
            iconTone="info"
            onClick={() => toggleShow("near_expiry")}
            active={show === "near_expiry"}
          />
          <StatCard
            size="sm"
            title="Held back"
            value={summary ? heldUnits.toLocaleString() : "—"}
            subtitle={
              summary
                ? `${summary.quarantinedUnits} quarantined · ${summary.reservedUnits} reserved`
                : undefined
            }
            icon={<IconLock size={16} />}
            iconTone="warning"
            onClick={() =>
              toggleShow(
                (summary?.quarantinedUnits ?? 0) > 0 || (summary?.reservedUnits ?? 0) === 0
                  ? "quarantined"
                  : "reserved",
              )
            }
            active={show === "quarantined" || show === "reserved"}
          />
        </div>
      )}

      <div className={css.toolbar}>
        <InventoryFilterPanel value={catalogFilters} options={catalogFilterOptions} onChange={setCatalogFilters} />
        <div className={css.searchWrap}>
          <IconSearch size={15} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            placeholder="Search by product, SKU, barcode…"
            aria-label="Search stock"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <InventoryFilterSelect
          label="Stock status"
          value={view}
          options={[
            { value: "all", label: "All" },
            { value: "ok", label: "Healthy" },
            { value: "low", label: "Low stock" },
            { value: "out", label: "Out of stock" },
          ]}
          onChange={(value) => setView(value as Exclude<StockView, "expiring">)}
        />
        <InventoryFilterSelect
          label="Show"
          value={show}
          options={SHOW_OPTIONS}
          onChange={(value) => setShow(value as ShowFilter)}
        />
        <InventoryFilterSelect
          label="Product type"
          value={productFilter}
          options={[
            { value: "all", label: "All products" },
            { value: "controlled", label: "Controlled" },
            { value: "regular", label: "Non-controlled" },
          ]}
          onChange={setProductFilter}
        />
        <button
          type="button"
          className={css.exportButton}
          onClick={exportRows}
          disabled={stock.rows.length === 0}
          data-tooltip={
            stock.rows.length === 0 ? "Nothing to export for the current filters" : "Download this page of stock as CSV"
          }
        >
          <IconDownload size={15} />
          Export
        </button>
      </div>

      {stock.error && (
        <Alert variant="error">
          {stock.error}{" "}
          <button type="button" className={css.rowTitleButton} onClick={() => void stock.reload()}>
            Try again
          </button>
        </Alert>
      )}

      <ActiveFilterBanner
        active={filtersActive}
        summary={`Filtered inventory · ${stock.total} product${stock.total === 1 ? "" : "s"}`}
        pills={activeFilterPills}
        onClear={clearFilters}
        clearTooltip="Reset all inventory filters"
      />

      <StockTable
        rows={stock.rows}
        loading={stock.loading}
        page={page}
        total={stock.total}
        sortKey={sort.key}
        sortDir={sort.dir}
        canAdjust={canAdjust}
        onSort={(key, dir) => setSort(dir ? { key, dir } : { key: "name", dir: "asc" })}
        onPageChange={setPage}
        onOpen={openSheet}
        onAdjust={adjustRow}
        emptyTitle={filtersActive ? "No products match these filters" : "No stock at this branch yet"}
        emptyDescription={
          filtersActive
            ? "Try another filter, or clear them to see everything"
            : "Receive a purchase order or import opening stock to get started"
        }
      />

      <ProductStockSheet
        productId={sheetProductId}
        access={access}
        onClose={() => setSheetProductId(null)}
        onAdjust={(productId, batchId) => openAdjustment(productId, batchId ?? "")}
        onChanged={(message) => refresh(message)}
      />

      <AdjustmentModal
        open={adjustmentOpen}
        onClose={() => setAdjustmentOpen(false)}
        initialProductId={adjustmentContext.productId}
        initialBatchId={adjustmentContext.batchId}
        onSuccess={(message) => refresh(message)}
      />
    </>
  );
}

export default function InventoryPage() {
  return (
    <Suspense fallback={<div className={css.loading}>Loading inventory…</div>}>
      <StockOverviewContent />
    </Suspense>
  );
}
