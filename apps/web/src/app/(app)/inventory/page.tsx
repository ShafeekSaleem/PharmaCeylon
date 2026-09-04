"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconActivity,
  IconAlertTriangle,
  IconCalendar,
  IconDownload,
  IconPackage,
  IconPlus,
  IconSearch,
  IconTruck,
} from "@/components/icons";
import { ProductContextBanner } from "@/components/product-context-banner";
import { ActionButton, ActiveFilterBanner, PageHeader, StatCard, type FilterPill } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { useProductMeta } from "../products/hooks/use-product-meta";
import { ProductStockBadge } from "../products/components/product-stock-badge";
import { AdjustmentModal } from "./components/adjustment-modal";
import { InventoryFilterSelect } from "./components/inventory-filter-select";
import {
  EMPTY_INVENTORY_CATALOG_FILTERS,
  InventoryFilterPanel,
  inventoryCatalogFiltersAreActive,
  type InventoryCatalogFilters,
} from "./components/inventory-filter-panel";
import { StockTable } from "./components/stock-table";
import { PAGE_SIZE, SUMMARY_PERIOD_OPTIONS } from "./constants";
import { useInventoryStock, useInventorySummary } from "./hooks/use-inventory-stock";
import css from "./inventory.module.css";
import type { StockRow, StockView, SummaryPeriod } from "./types";
import {
  formatMoney,
  hasInventoryWriteAccess,
  stockStatusLabel,
} from "./utils";
import { InventorySubnav } from "./components/inventory-subnav";

function StockOverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const canWrite = hasInventoryWriteAccess(user, branchId);
  const productMeta = useProductMeta();

  const productIdFilter = searchParams.get("productId");
  const initialView = (searchParams.get("view") as StockView | null) ?? "all";
  const [view, setView] = useState<StockView>(
    initialView === "ok" || initialView === "low" || initialView === "out"
      ? initialView
      : "all",
  );
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<SummaryPeriod>("this_month");
  const [batchFilter, setBatchFilter] = useState(
    initialView === "expiring" ? "expiring" : "all",
  );
  const initialControlled = searchParams.get("controlled");
  const [productFilter, setProductFilter] = useState(
    initialControlled === "controlled" || initialControlled === "regular"
      ? initialControlled
      : "all",
  );
  const [catalogFilters, setCatalogFilters] = useState<InventoryCatalogFilters>(
    EMPTY_INVENTORY_CATALOG_FILTERS,
  );
  const [facetBrands, setFacetBrands] = useState<{ value: string; label: string; count: number }[]>([]);
  const [facetForms, setFacetForms] = useState<{ value: string; label: string; count: number }[]>([]);
  const [adjustmentOpen, setAdjustmentOpen] = useState(
    searchParams.get("openAdjustment") === "1",
  );
  const [adjustmentContext, setAdjustmentContext] = useState<{
    productId: string;
    batchId: string;
  }>({
    productId: searchParams.get("productId") ?? "",
    batchId: searchParams.get("batchId") ?? "",
  });
  const [adjustmentSuccess, setAdjustmentSuccess] = useState<string | null>(null);

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
    if (!adjustmentSuccess) return;
    const t = setTimeout(() => setAdjustmentSuccess(null), 6000);
    return () => clearTimeout(t);
  }, [adjustmentSuccess]);

  useEffect(() => {
    apiJson<{
      brands: { value: string; count: number }[];
      dosageForms: { value: string; count: number }[];
    }>("/catalog/facets")
      .then((facets) => {
        setFacetBrands(
          (facets.brands ?? []).map((b) => ({ value: b.value, label: b.value, count: b.count })),
        );
        setFacetForms(
          (facets.dosageForms ?? []).map((f) => ({ value: f.value, label: f.value, count: f.count })),
        );
      })
      .catch(() => {
        setFacetBrands([]);
        setFacetForms([]);
      });
  }, []);

  function openAdjustment(row?: StockRow) {
    setAdjustmentContext({ productId: row?.productId ?? "", batchId: "" });
    setAdjustmentOpen(true);
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [
    view,
    debouncedQ,
    productIdFilter,
    batchFilter,
    productFilter,
    catalogFilters,
  ]);

  const statusFilter =
    view === "ok" || view === "low" || view === "out" ? view : "all";

  const stock = useInventoryStock({
    status: statusFilter,
    q: debouncedQ,
    page,
    pageSize: PAGE_SIZE,
    productId: productIdFilter,
    controlled:
      productFilter === "controlled" || productFilter === "regular"
        ? productFilter
        : "all",
    batchFilter:
      batchFilter === "expiring" ||
      batchFilter === "with_batches" ||
      batchFilter === "no_batches"
        ? batchFilter
        : "all",
    catalogFilters,
  });
  const alertsStock = useInventoryStock({
    page: 1,
    pageSize: 5,
    batchFilter: "expiring",
    ledgerOnly: true,
  });
  const lowAlertsStock = useInventoryStock({
    status: "low",
    page: 1,
    pageSize: 5,
    ledgerOnly: true,
  });
  const { summary, reload: reloadSummary } = useInventorySummary(period);
  const periodStats = summary?.period ?? null;
  const fallbackMonth = summary?.month;
  const received = periodStats?.received ?? fallbackMonth?.received ?? 0;
  const issued = periodStats?.issued ?? fallbackMonth?.issued ?? 0;
  const adjustments = periodStats?.adjustments ?? fallbackMonth?.adjustments ?? 0;
  const net = periodStats?.net ?? fallbackMonth?.net ?? 0;

  const rows = stock.rows;

  const catalogFilterOptions = useMemo(() => {
    const byLabel = (left: { label: string }, right: { label: string }) =>
      left.label.localeCompare(right.label);
    return {
      // Kept as raw rows (with parentCategoryId) — InventoryFilterPanel nests them into the
      // same COMMERCIAL department tree the Products page's Category filter uses.
      categories: productMeta.categories,
      tags: productMeta.tags
        .map((tag) => ({ value: tag.id, label: tag.name, count: tag.productCount ?? 0 }))
        .sort(byLabel),
      brands: [...facetBrands].sort(byLabel),
      dosageForms: [...facetForms].sort(byLabel),
    };
  }, [productMeta.categories, productMeta.tags, facetBrands, facetForms]);

  const alerts = useMemo(() => {
    const merged = new Map<string, StockRow>();
    for (const row of [...lowAlertsStock.rows, ...alertsStock.rows]) {
      merged.set(row.productId, row);
    }
    return [...merged.values()].slice(0, 5);
  }, [lowAlertsStock.rows, alertsStock.rows]);

  const setViewFromStat = (next: StockView) => {
    if (next === "expiring") {
      setBatchFilter((prev) => (prev === "expiring" ? "all" : "expiring"));
      return;
    }
    setView((prev) => (prev === next ? "all" : next));
  };

  const clearFilters = () => {
    setView("all");
    setBatchFilter("all");
    setProductFilter("all");
    setCatalogFilters(EMPTY_INVENTORY_CATALOG_FILTERS);
    if (productIdFilter) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("productId");
      const qs = next.toString();
      router.replace(qs ? `/inventory?${qs}` : "/inventory");
    }
  };

  const exportRows = () => {
    const escapeCsv = (value: string | number | null) => {
      const text = String(value ?? "");
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const header = [
      "Product",
      "SKU",
      "Barcode",
      "On hand",
      "Stock status",
      "Reorder level",
      "Batches",
      "Near-expiry batches",
      "Last movement",
    ];
    const csv = [
      header,
      ...rows.map((row) => [
        row.product.name,
        row.product.sku,
        row.product.barcode,
        row.qtyOnHand,
        stockStatusLabel(row.stockStatus),
        row.product.reorderLevel,
        row.batchCount,
        row.nearExpiryBatchCount,
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
    batchFilter !== "all" ||
    productFilter !== "all" ||
    !!productIdFilter ||
    inventoryCatalogFiltersAreActive(catalogFilters);

  const VIEW_LABELS: Record<string, string> = { ok: "In stock", low: "Low stock", out: "Out of stock" };
  const BATCH_LABELS: Record<string, string> = {
    expiring: "Expiring soon",
    with_batches: "Has batches",
    no_batches: "No batches",
  };
  const PRODUCT_TYPE_LABELS: Record<string, string> = {
    controlled: "Controlled",
    regular: "Non-controlled",
  };

  const activeFilterPills: FilterPill[] = [
    ...(view !== "all" ? [{ key: "view", label: `Stock: ${VIEW_LABELS[view] ?? view}` }] : []),
    ...(batchFilter !== "all"
      ? [{ key: "batch", label: `Batch: ${BATCH_LABELS[batchFilter] ?? batchFilter}` }]
      : []),
    ...(productFilter !== "all"
      ? [{ key: "productType", label: PRODUCT_TYPE_LABELS[productFilter] ?? productFilter }]
      : []),
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

  return (
    <>
      <ProductContextBanner />
      <PageHeader
        subtitleOnly
        floatingActions
        description="Track stock levels, batches, and adjustments for the selected branch."
        actions={
          canWrite ? (
            <ActionButton
              icon={<IconPlus size={16} />}
              tooltip="Post a stock quantity correction"
              onClick={() => openAdjustment()}
            >
              New adjustment
            </ActionButton>
          ) : null
        }
      />

      <InventorySubnav />

      {adjustmentSuccess && <Alert variant="success">{adjustmentSuccess}</Alert>}

      {!stock.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to view inventory for that location.
        </div>
      )}

      {stock.hasBranch && (
        <div className={css.kpiRow}>
          <StatCard size="sm"
            title="Total items"
            value={summary?.skuCount ?? "—"}
            subtitle={`${summary?.totalUnits ?? 0} units on hand`}
            icon={<IconPackage size={16} />}
            iconTone="primary"
            onClick={clearFilters}
            active={!filtersActive}
          />
          <StatCard size="sm"
            title="Stock value"
            value={summary ? formatMoney(summary.stockValue) : "—"}
            subtitle="At cost for on-hand batches"
            icon={<IconActivity size={16} />}
            iconTone="success"
          />
          <StatCard size="sm"
            title="Low stock"
            value={summary?.lowStock ?? "—"}
            subtitle="Reorder soon"
            icon={<IconAlertTriangle size={16} />}
            iconTone="warning"
            onClick={() => setViewFromStat("low")}
            active={view === "low"}
          />
          <StatCard size="sm"
            title="Out of stock"
            value={summary?.outOfStock ?? "—"}
            subtitle="Needs attention"
            icon={<IconAlertTriangle size={16} />}
            iconTone="danger"
            onClick={() => setViewFromStat("out")}
            active={view === "out"}
          />
          <StatCard size="sm"
            title="Expiring soon"
            value={summary?.nearExpiryProducts ?? "—"}
            subtitle={`${summary?.nearExpiry ?? 0} batches ≤30 days`}
            icon={<IconCalendar size={16} />}
            iconTone="info"
            onClick={() => setViewFromStat("expiring")}
            active={batchFilter === "expiring"}
          />
        </div>
      )}

      <div className={css.dashboard}>
        <div className={css.mainCol}>
          <div className={css.toolbar}>
            <InventoryFilterPanel
              value={catalogFilters}
              options={catalogFilterOptions}
              onChange={setCatalogFilters}
            />
            <div className={css.searchWrap}>
              <IconSearch size={15} className={css.searchIcon} />
              <input
                type="search"
                className={css.searchInput}
                placeholder="Search by product, SKU, barcode…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <InventoryFilterSelect
              label="Stock status"
              value={view}
              options={[
                { value: "all", label: "All" },
                { value: "ok", label: "In stock" },
                { value: "low", label: "Low stock" },
                { value: "out", label: "Out of stock" },
              ]}
              onChange={(value) => setView(value as StockView)}
            />
            <InventoryFilterSelect
              label="Batch status"
              value={batchFilter}
              options={[
                { value: "all", label: "All batches" },
                { value: "expiring", label: "Expiring soon" },
                { value: "with_batches", label: "Has batches" },
                { value: "no_batches", label: "No batches" },
              ]}
              onChange={setBatchFilter}
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
              disabled={rows.length === 0}
              data-tooltip={
                rows.length === 0
                  ? "Nothing to export for the current filters"
                  : "Download filtered stock as CSV"
              }
            >
              <IconDownload size={15} />
              Export
            </button>
          </div>

          {stock.error && <Alert variant="error">{stock.error}</Alert>}

          <ActiveFilterBanner
            active={filtersActive}
            summary={`Filtered inventory · ${stock.total} item${stock.total === 1 ? "" : "s"}`}
            pills={activeFilterPills}
            onClear={clearFilters}
            clearTooltip="Reset all inventory filters"
          />

          <StockTable
            rows={rows}
            loading={stock.loading}
            page={page}
            total={stock.total}
            onPageChange={setPage}
            onAdjust={openAdjustment}
          />
        </div>

        <aside className={css.sideCol}>
          <div className={css.sideCard}>
            <div className={css.summaryHeader}>
              <h3 className={`${css.sideCardTitle} ${css.sideCardTitleFlush}`}>
                Inventory summary
              </h3>
              <InventoryFilterSelect
                label="Period"
                value={period}
                options={SUMMARY_PERIOD_OPTIONS}
                onChange={(value) => setPeriod(value as SummaryPeriod)}
              />
            </div>
            {periodStats?.label && (
              <p className={css.periodLabel}>{periodStats.label}</p>
            )}
            <div className={css.monthGrid}>
              <div className={css.monthRow}>
                <span>Received</span>
                <span className={`${css.summaryValue} ${css.metricIn}`}>+{received}</span>
              </div>
              <div className={css.monthRow}>
                <span>Issued</span>
                <span className={`${css.summaryValue} ${css.metricOut}`}>−{issued}</span>
              </div>
              <div className={css.monthRow}>
                <span>Adjustments</span>
                <span
                  className={`${css.summaryValue} ${
                    adjustments >= 0 ? css.metricIn : css.metricOut
                  }`}
                >
                  {adjustments > 0 ? "+" : ""}
                  {adjustments}
                </span>
              </div>
              <div className={`${css.monthRow} ${css.monthRowNet}`}>
                <span>Net change</span>
                <span className={`${css.summaryValue} ${net >= 0 ? css.metricIn : css.metricOut}`}>
                  {net > 0 ? "+" : ""}
                  {net}
                </span>
              </div>
            </div>
          </div>

          <div className={css.sideCard}>
            <h3 className={css.sideCardTitle}>Stock alerts</h3>
            {alerts.length === 0 ? (
              <p className={css.fieldHint}>No critical alerts right now.</p>
            ) : (
              <ul className={css.alertList}>
                {alerts.map((a) => (
                  <li key={a.productId}>
                    <Link href={`/products/${a.productId}`} className={css.alertItem}>
                      <div>
                        <div className={css.alertItemName}>{a.product.name}</div>
                        <div className={css.alertItemMeta}>
                          {stockStatusLabel(a.stockStatus)}
                          {a.nearExpiryBatchCount > 0 ? " · Expiring" : ""}
                        </div>
                      </div>
                      <ProductStockBadge
                        qtyOnHand={a.qtyOnHand}
                        stockStatus={a.stockStatus}
                        variant="inline"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={css.sideCard}>
            <h3 className={css.sideCardTitle}>Related</h3>
            <ul className={css.quickList}>
              <li>
                <Link href="/purchasing" className={css.quickItem}>
                  <span className={css.quickIcon}>
                    <IconPackage size={14} />
                  </span>
                  Receive / purchase stock
                </Link>
              </li>
              <li>
                <Link href="/transfers" className={css.quickItem}>
                  <span className={css.quickIcon}>
                    <IconTruck size={14} />
                  </span>
                  Transfer stock
                </Link>
              </li>
            </ul>
          </div>
        </aside>
      </div>

      <AdjustmentModal
        open={adjustmentOpen}
        onClose={() => setAdjustmentOpen(false)}
        initialProductId={adjustmentContext.productId}
        initialBatchId={adjustmentContext.batchId}
        onSuccess={(message) => {
          setAdjustmentSuccess(message);
          void stock.reload();
          void reloadSummary();
        }}
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
