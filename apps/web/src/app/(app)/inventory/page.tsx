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
import { ActionButton, PageHeader, StatCard } from "@/components/ui";
import { useAuth } from "@/lib/use-auth";
import { ProductStockBadge } from "../products/components/product-stock-badge";
import { InventoryFilterSelect } from "./components/inventory-filter-select";
import {
  EMPTY_INVENTORY_CATALOG_FILTERS,
  InventoryMoreFilters,
  inventoryCatalogFiltersAreActive,
  type InventoryCatalogFilters,
} from "./components/inventory-more-filters";
import { StockTable } from "./components/stock-table";
import { SUMMARY_PERIOD_OPTIONS } from "./constants";
import { useInventoryStock, useInventorySummary } from "./hooks/use-inventory-stock";
import css from "./inventory.module.css";
import type { StockView, SummaryPeriod } from "./types";
import {
  formatMoney,
  hasInventoryWriteAccess,
  stockStatusLabel,
} from "./utils";

function StockOverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, branchId } = useAuth();
  const canWrite = hasInventoryWriteAccess(user, branchId);

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
  const [productFilter, setProductFilter] = useState("all");
  const [catalogFilters, setCatalogFilters] = useState<InventoryCatalogFilters>(
    EMPTY_INVENTORY_CATALOG_FILTERS,
  );

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

  const stock = useInventoryStock("all", debouncedQ);
  const { summary } = useInventorySummary(period);
  const periodStats = summary?.period ?? null;
  const fallbackMonth = summary?.month;
  const received = periodStats?.received ?? fallbackMonth?.received ?? 0;
  const issued = periodStats?.issued ?? fallbackMonth?.issued ?? 0;
  const adjustments = periodStats?.adjustments ?? fallbackMonth?.adjustments ?? 0;
  const net = periodStats?.net ?? fallbackMonth?.net ?? 0;

  const rows = useMemo(() => {
    let list = productIdFilter
      ? stock.rows.filter((r) => r.productId === productIdFilter)
      : stock.rows;
    if (view === "ok") list = list.filter((r) => r.stockStatus === "ok");
    if (view === "low") list = list.filter((r) => r.stockStatus === "low");
    else if (view === "out") list = list.filter((r) => r.stockStatus === "out");
    if (batchFilter === "expiring") {
      list = list.filter((r) => r.nearExpiryBatchCount > 0);
    } else if (batchFilter === "with_batches") {
      list = list.filter((r) => r.batchCount > 0);
    } else if (batchFilter === "no_batches") {
      list = list.filter((r) => r.batchCount === 0);
    }
    if (productFilter === "controlled") {
      list = list.filter((r) => r.product.isControlled);
    } else if (productFilter === "regular") {
      list = list.filter((r) => !r.product.isControlled);
    }
    if (catalogFilters.categories.length > 0) {
      list = list.filter((row) =>
        (row.product.categories ?? []).some((category) =>
          catalogFilters.categories.includes(category.id),
        ),
      );
    }
    if (catalogFilters.brands.length > 0) {
      list = list.filter(
        (row) =>
          row.product.brandName != null &&
          catalogFilters.brands.includes(row.product.brandName),
      );
    }
    if (catalogFilters.tags.length > 0) {
      list = list.filter((row) =>
        (row.product.tags ?? []).some((tag) =>
          catalogFilters.tags.includes(tag.id),
        ),
      );
    }
    if (catalogFilters.dosageForms.length > 0) {
      list = list.filter(
        (row) =>
          row.product.dosageForm != null &&
          catalogFilters.dosageForms.includes(row.product.dosageForm),
      );
    }
    return list;
  }, [
    stock.rows,
    productIdFilter,
    view,
    batchFilter,
    productFilter,
    catalogFilters,
  ]);

  const catalogFilterOptions = useMemo(() => {
    const categories = new Map<string, string>();
    const tags = new Map<string, string>();
    const brands = new Set<string>();
    const dosageForms = new Set<string>();
    for (const row of stock.rows) {
      for (const category of row.product.categories ?? []) {
        categories.set(category.id, category.name);
      }
      for (const tag of row.product.tags ?? []) {
        tags.set(tag.id, tag.name);
      }
      if (row.product.brandName) brands.add(row.product.brandName);
      if (row.product.dosageForm) dosageForms.add(row.product.dosageForm);
    }
    const byLabel = (
      left: { label: string },
      right: { label: string },
    ) => left.label.localeCompare(right.label);
    return {
      categories: [...categories].map(([value, label]) => ({ value, label })).sort(byLabel),
      tags: [...tags].map(([value, label]) => ({ value, label })).sort(byLabel),
      brands: [...brands].map((value) => ({ value, label: value })).sort(byLabel),
      dosageForms: [...dosageForms]
        .map((value) => ({ value, label: value }))
        .sort(byLabel),
    };
  }, [stock.rows]);

  const alerts = useMemo(() => {
    return stock.rows
      .filter(
        (r) =>
          r.stockStatus === "out" ||
          r.stockStatus === "low" ||
          r.nearExpiryBatchCount > 0,
      )
      .slice(0, 5);
  }, [stock.rows]);

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
              onClick={() => router.push("/inventory/adjustments")}
            >
              New adjustment
            </ActionButton>
          ) : null
        }
      />

      {!stock.hasBranch && (
        <div className={css.branchNotice}>
          Select a branch in the header to view inventory for that location.
        </div>
      )}

      {stock.hasBranch && (
        <div className={css.kpiRow}>
          <StatCard
            title="Total items"
            value={summary?.skuCount ?? "—"}
            subtitle={`${summary?.totalUnits ?? 0} units on hand`}
            icon={<IconPackage size={16} />}
            iconTone="primary"
            onClick={clearFilters}
            active={!filtersActive}
          />
          <StatCard
            title="Stock value"
            value={summary ? formatMoney(summary.stockValue) : "—"}
            subtitle="At cost for on-hand batches"
            icon={<IconActivity size={16} />}
            iconTone="success"
          />
          <StatCard
            title="Low stock"
            value={summary?.lowStock ?? "—"}
            subtitle="Reorder soon"
            icon={<IconAlertTriangle size={16} />}
            iconTone="warning"
            onClick={() => setViewFromStat("low")}
            active={view === "low"}
          />
          <StatCard
            title="Out of stock"
            value={summary?.outOfStock ?? "—"}
            subtitle="Needs attention"
            icon={<IconAlertTriangle size={16} />}
            iconTone="danger"
            onClick={() => setViewFromStat("out")}
            active={view === "out"}
          />
          <StatCard
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
            <InventoryMoreFilters
              value={catalogFilters}
              options={catalogFilterOptions}
              onChange={setCatalogFilters}
            />
            <button
              type="button"
              className={css.exportButton}
              onClick={exportRows}
              disabled={rows.length === 0}
            >
              <IconDownload size={15} />
              Export
            </button>
          </div>

          {stock.error && <Alert variant="error">{stock.error}</Alert>}

          {filtersActive && (
            <div className={css.activeFilter}>
              <span>
                Filtered inventory · {rows.length} item{rows.length === 1 ? "" : "s"}
              </span>
              <button type="button" className={css.clearFilter} onClick={clearFilters}>
                Clear filter
              </button>
            </div>
          )}

          <StockTable
            rows={rows}
            loading={stock.loading}
            page={page}
            canWrite={canWrite}
            onPageChange={setPage}
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
