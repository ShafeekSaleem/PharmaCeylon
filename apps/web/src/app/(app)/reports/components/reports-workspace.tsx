"use client";

import { useEffect, useMemo, useState } from "react";
import { IconInfo } from "@/components/icons";
import { useReportsFilters } from "../lib/use-reports-filters";
import { categoryDef, reportDef } from "../lib/nav-config";
import { CategoryNav } from "./category-nav";
import { FilterBar } from "./filter-bar";
import { ReportSelect } from "./report-select";
import { ComingSoonPanel } from "./coming-soon-panel";
import { SyncFreshnessNotice } from "./sync-freshness-notice";
import { SalesSection } from "../sections/sales-section";
import { ProductSalesSection } from "../sections/product-sales-section";
import { CategorySalesSection } from "../sections/category-sales-section";
import { BranchSalesSection } from "../sections/branch-sales-section";
import { CashierPerformanceSection } from "../sections/cashier-performance-section";
import { PaymentMethodsSection } from "../sections/payment-methods-section";
import { ReturnsDiscountsSection } from "../sections/returns-discounts-section";
import { ShiftCashSection } from "../sections/shift-cash-section";
import { GrossProfitSection } from "../sections/gross-profit-section";
import { ProfitabilitySection } from "../sections/profitability-section";
import { MarginByCategorySection } from "../sections/margin-by-category-section";
import { BranchProfitabilitySection } from "../sections/branch-profitability-section";
import { NearExpirySection } from "../sections/near-expiry-section";
import { StockHealthSection } from "../sections/stock-health-section";
import { InventorySummarySection, type ValuationBasis } from "../sections/inventory-summary-section";
import { StockMovementSection } from "../sections/stock-movement-section";
import { TransfersReportSection } from "../sections/transfers-report-section";
import { StocktakesReportSection } from "../sections/stocktakes-report-section";
import { PurchaseSummarySection } from "../sections/purchase-summary-section";
import { SupplierSpendSection } from "../sections/supplier-spend-section";
import { SupplierPerformanceSection } from "../sections/supplier-performance-section";
import { exportRowsToCsv } from "../lib/csv";
import { OFFLINE_SALE_SYNC_STATE_OPTIONS, SALE_CHANNELS, type OfflineSaleSyncState, type SaleChannel } from "@pharmaceylon/shared";
import { fetchSalesHistoryOptions } from "../../sales/services/sales-api";
import { registersForPicker } from "../../sales/register-options";
import { shiftOptionLabel, shiftsForPicker } from "../../sales/shift-options";
import type { SalesHistoryOptions } from "../../sales/types";
import { DIMENSION_REPORTS, REPORT_CHANNEL_LABELS, type SalesDimensions } from "../lib/sales-dimensions";
import { fetchCommercialCategories, fetchSuppliersForFilter } from "../lib/fetchers";
import type { CategoryGroupBy, CommercialCategoryRow, ExportPayload, MovementTypeFilterKey } from "../lib/types";
import css from "../reports.module.css";

const CATEGORY_GROUP_BY_OPTIONS: { value: CategoryGroupBy; label: string }[] = [
  { value: "commercial", label: "Commercial Category" },
  { value: "dosageForm", label: "Dosage Form" },
  { value: "schedule", label: "Schedule" },
  { value: "registrationType", label: "Registration Type" },
];

const VALUATION_BASIS_OPTIONS: { value: ValuationBasis; label: string }[] = [
  { value: "cost", label: "Cost Price (Avg.)" },
  { value: "retail", label: "Retail Price (MRP)" },
];

const MOVEMENT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All movement types" },
  { value: "purchase_receipts", label: "Purchase Receipts" },
  { value: "sales_outbound", label: "Sales / Outbound" },
  { value: "transfers_in", label: "Transfers In" },
  { value: "transfers_out", label: "Transfers Out" },
  { value: "returns_in", label: "Returns In" },
  { value: "returns_out", label: "Returns Out" },
  { value: "adjustments", label: "Adjustments" },
  { value: "stocktake_adjustments", label: "Stocktake Adjustments" },
];

const COMPARABLE_REPORTS = new Set([
  "sales-summary",
  "product-sales",
  "category-sales",
  "branch-sales",
  "cashier-performance",
  "payment-methods",
  "returns-discounts",
  "gross-profit",
  "margin-by-product",
  "margin-by-category",
  "branch-profitability",
  "expiry-batch-risk",
]);

/** Reports built from sales or stock: their totals miss what an offline counter hasn't synced or
 *  whose stock hasn't posted, so they carry the P5 freshness caveat. Purchasing doesn't. */
const SYNC_SENSITIVE_CATEGORIES = new Set(["sales", "profitability", "inventory"]);
const EVERY_BRANCH_REPORTS = new Set(["branch-sales", "branch-profitability"]);

export function ReportsWorkspace() {
  const filters = useReportsFilters();
  const { category, report, navigate, scope, setScope, isOwner, branchId, setBranchId, branches, currentBranch } = filters;

  const activeCategory = categoryDef(category);
  const activeReport = reportDef(category, report);
  // `ready` only reflects auth having resolved — `branches` has its own independent async fetch
  // (see `useReportsFilters`) that can still be mid-flight even once `ready` is true, so gating on
  // `ready` alone left a window where a genuinely multi-branch tenant read as branch-less. Every
  // tenant has at least one branch, so an empty array only ever means "not loaded yet", never a
  // real zero-branch tenant — using that directly is the reliable "has it actually loaded" signal.
  const branchesLoaded = branches.length > 0;
  const branchCount = branchesLoaded ? branches.length : Infinity;

  // Deep-link guard: a bookmarked/shared `?report=branch-profitability`/`?report=branch-sales`
  // link on a since-reduced or always-single-branch tenant redirects to the category's default
  // report instead of rendering a report that no longer applies (or showing a misleading
  // "coming soon" panel).
  useEffect(() => {
    if (branchesLoaded && report === "branch-profitability" && branches.length < 2) {
      navigate("profitability");
    }
  }, [branchesLoaded, report, branches.length, navigate]);

  useEffect(() => {
    if (branchesLoaded && report === "branch-sales" && branches.length < 2) {
      navigate("sales");
    }
  }, [branchesLoaded, report, branches.length, navigate]);

  const [periods, setPeriods] = useState<Record<string, number>>({});
  const [exportPayload, setExportPayload] = useState<ExportPayload | null>(null);
  const [branchCity, setBranchCity] = useState<string>("all");
  const [categoryGroupBy, setCategoryGroupBy] = useState<CategoryGroupBy>("commercial");
  const [excludeUnclassified, setExcludeUnclassified] = useState(false);
  const [expiryCategoryId, setExpiryCategoryId] = useState<string>("all");
  const [expirySupplierId, setExpirySupplierId] = useState<string>("all");
  const [expiryCategories, setExpiryCategories] = useState<CommercialCategoryRow[]>([]);
  const [expirySuppliers, setExpirySuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [stockValueCategoryId, setStockValueCategoryId] = useState<string>("all");
  const [stockValueSupplierId, setStockValueSupplierId] = useState<string>("all");
  const [stockValueBasis, setStockValueBasis] = useState<ValuationBasis>("cost");
  const [deadStockCategoryId, setDeadStockCategoryId] = useState<string>("all");
  const [deadStockSupplierId, setDeadStockSupplierId] = useState<string>("all");
  const [movementCategoryId, setMovementCategoryId] = useState<string>("all");
  const [movementSupplierId, setMovementSupplierId] = useState<string>("all");
  const [movementTypeFilter, setMovementTypeFilter] = useState<string>("all");
  // W10 #72: counter, shift and channel, for the sales reports that can be narrowed by them.
  const [salesOptions, setSalesOptions] = useState<SalesHistoryOptions | null>(null);
  const [dimRegisterId, setDimRegisterId] = useState("all");
  const [dimShiftId, setDimShiftId] = useState("all");
  const [dimChannel, setDimChannel] = useState<"all" | SaleChannel>("all");
  const [dimSyncState, setDimSyncState] = useState<"all" | OfflineSaleSyncState>("all");
  const period = periods[report] ?? activeReport?.defaultPeriod ?? 30;
  const setPeriod = (n: number) => setPeriods((prev) => ({ ...prev, [report]: n }));

  const cityOptions = useMemo(
    () => [...new Set(branches.map((b) => b.city).filter((c): c is string => !!c))].sort(),
    [branches],
  );
  // Near Expiry is scoped to Medicines only (see reports.service.ts#nearExpiry) — this offers
  // Medicines' own leaf sub-categories (Pain & Fever, Anti-infectives, ...), not the flat
  // top-level department list every other report's category filter uses.
  const expiryCategoryOptions = useMemo(() => {
    const medicines = expiryCategories.find((c) => c.parentCategoryId === null && c.name === "Medicines");
    const subCategories = medicines ? expiryCategories.filter((c) => c.parentCategoryId === medicines.id) : [];
    return [{ value: "all", label: "All sub-categories" }, ...subCategories.map((c) => ({ value: c.id, label: c.name }))];
  }, [expiryCategories]);
  const expirySupplierOptions = useMemo(
    () => [{ value: "all", label: "All suppliers" }, ...expirySuppliers.map((s) => ({ value: s.id, label: s.name }))],
    [expirySuppliers],
  );
  // Stock Value spans every department (unlike Near Expiry/Stock Ageing, which are Medicines-only)
  // — its own Category filter offers the flat top-level department list instead.
  const stockValueCategoryOptions = useMemo(() => {
    const departments = expiryCategories.filter((c) => c.parentCategoryId === null);
    return [{ value: "all", label: "All categories" }, ...departments.map((c) => ({ value: c.id, label: c.name }))];
  }, [expiryCategories]);
  const stockValueSupplierOptions = useMemo(
    () => [{ value: "all", label: "All suppliers" }, ...expirySuppliers.map((s) => ({ value: s.id, label: s.name }))],
    [expirySuppliers],
  );

  useEffect(() => {
    fetchCommercialCategories().then(setExpiryCategories).catch(() => {});
    fetchSuppliersForFilter().then(setExpirySuppliers).catch(() => {});
    // Without the sales history options (no access, or a failed read) the counter and shift
    // pickers stay hidden; Channel needs no options and still works.
    fetchSalesHistoryOptions().then(setSalesOptions).catch(() => {});
  }, []);

  // Counters and shifts belong to a branch, so a different branch or scope starts unfiltered.
  useEffect(() => {
    setDimRegisterId("all");
    setDimShiftId("all");
  }, [branchId, scope]);

  const optionBranchId = scope === "tenant" ? null : branchId;
  const counterOptions = useMemo(() => {
    if (!salesOptions) return [];
    const picks = registersForPicker(salesOptions.registers, optionBranchId, salesOptions.branches);
    return [{ value: "all", label: "All counters" }, ...picks.map((r) => ({ value: r.registerId, label: r.counterLabel }))];
  }, [salesOptions, optionBranchId]);
  const shiftOptions = useMemo(() => {
    if (!salesOptions) return [];
    const picks = shiftsForPicker(salesOptions.shifts ?? [], optionBranchId).filter(
      (s) => dimRegisterId === "all" || s.registerId === dimRegisterId,
    );
    return [
      { value: "all", label: "All shifts" },
      ...picks.map((s) => ({ value: s.shiftId, label: shiftOptionLabel(s, optionBranchId, salesOptions.branches) })),
    ];
  }, [salesOptions, optionBranchId, dimRegisterId]);
  const channelOptions = useMemo(
    () => [{ value: "all", label: "All channels" }, ...SALE_CHANNELS.map((c) => ({ value: c, label: REPORT_CHANNEL_LABELS[c] }))],
    [],
  );
  const syncStateOptions = useMemo(
    () => [{ value: "all", label: "Any sync state" }, ...OFFLINE_SALE_SYNC_STATE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))],
    [],
  );

  const dims: SalesDimensions = useMemo(
    () => ({
      ...(dimRegisterId !== "all" ? { registerId: dimRegisterId } : {}),
      ...(dimShiftId !== "all" ? { shiftId: dimShiftId } : {}),
      ...(dimChannel !== "all" ? { channel: dimChannel } : {}),
      ...(dimChannel === "offline" && dimSyncState !== "all" ? { offlineSyncState: dimSyncState } : {}),
    }),
    [dimRegisterId, dimShiftId, dimChannel, dimSyncState],
  );

  function pickCounter(id: string) {
    setDimRegisterId(id);
    // A shift is on one counter; keep it only if it is on the new one.
    const shift = salesOptions?.shifts?.find((s) => s.shiftId === dimShiftId);
    if (id !== "all" && shift && shift.registerId !== id) setDimShiftId("all");
  }

  const dimensionFilters = DIMENSION_REPORTS.has(report) ? (
    <>
      {counterOptions.length > 1 ? (
        <div className={css.filterfield}>
          <label>Counter</label>
          <ReportSelect ariaLabel="Counter" value={dimRegisterId} onChange={pickCounter} options={counterOptions} />
        </div>
      ) : null}
      {shiftOptions.length > 1 ? (
        <div className={css.filterfield}>
          <label>Shift</label>
          <ReportSelect ariaLabel="Shift" value={dimShiftId} onChange={setDimShiftId} options={shiftOptions} />
        </div>
      ) : null}
      <div className={css.filterfield}>
        <label>Channel</label>
        <ReportSelect ariaLabel="Channel" value={dimChannel} onChange={(v) => setDimChannel(v as "all" | SaleChannel)} options={channelOptions} />
      </div>
      {dimChannel === "offline" ? (
        <div className={css.filterfield}>
          <label>Sync state</label>
          <ReportSelect
            ariaLabel="Sync state"
            value={dimSyncState}
            onChange={(v) => setDimSyncState(v as "all" | OfflineSaleSyncState)}
            options={syncStateOptions}
          />
        </div>
      ) : null}
    </>
  ) : null;

  function resetFilters() {
    setScope("branch");
    if (activeReport?.defaultPeriod != null) setPeriod(activeReport.defaultPeriod);
    setBranchCity("all");
    setCategoryGroupBy("commercial");
    setExcludeUnclassified(false);
    setExpiryCategoryId("all");
    setExpirySupplierId("all");
    setStockValueCategoryId("all");
    setStockValueSupplierId("all");
    setStockValueBasis("cost");
    setDeadStockCategoryId("all");
    setDeadStockSupplierId("all");
    setMovementCategoryId("all");
    setMovementSupplierId("all");
    setMovementTypeFilter("all");
    setDimRegisterId("all");
    setDimShiftId("all");
    setDimChannel("all");
    setDimSyncState("all");
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div className={css.page}>
      <p style={{ margin: "0 0 0.6rem", fontSize: "0.83rem", color: "var(--pc-muted-fg)" }}>
        Performance, profitability, and stock risk insights for smarter decisions.
      </p>

      <CategoryNav category={category} report={report} onNavigate={navigate} branchCount={branchCount} />

      <FilterBar
        branches={branches}
        branchId={branchId}
        onBranchChange={setBranchId}
        isOwner={isOwner}
        scope={scope}
        onScopeChange={setScope}
        hideBranchScope={report === "branch-sales" || report === "branch-profitability"}
        periodLabel={activeReport?.periodLabel}
        periodOptions={activeReport?.periodOptions}
        period={period}
        onPeriodChange={setPeriod}
        showCompare={COMPARABLE_REPORTS.has(report)}
        extraFilters={
          report === "category-sales" ? (
            <>
              <div className={css.filterfield}>
                <label>Group By</label>
                <ReportSelect
                  ariaLabel="Group By"
                  value={categoryGroupBy}
                  onChange={(v) => setCategoryGroupBy(v as CategoryGroupBy)}
                  options={CATEGORY_GROUP_BY_OPTIONS}
                />
              </div>
              <label className={css.inlineCheckField}>
                <input
                  type="checkbox"
                  checked={excludeUnclassified}
                  onChange={(e) => setExcludeUnclassified(e.target.checked)}
                />
                Exclude unclassified
              </label>
              {dimensionFilters}
            </>
          ) : DIMENSION_REPORTS.has(report) ? (
            dimensionFilters
          ) : report === "branch-sales" ? (
            <div className={css.filterfield}>
              <label>City</label>
              <ReportSelect
                ariaLabel="City"
                value={branchCity}
                onChange={setBranchCity}
                options={[{ value: "all", label: "All cities" }, ...cityOptions.map((c) => ({ value: c, label: c }))]}
              />
            </div>
          ) : report === "inventory-summary" ? (
            <>
              <div className={css.filterfield}>
                <label>Category</label>
                <ReportSelect ariaLabel="Category" value={stockValueCategoryId} onChange={setStockValueCategoryId} options={stockValueCategoryOptions} />
              </div>
              <div className={css.filterfield}>
                <label>Supplier</label>
                <ReportSelect ariaLabel="Supplier" value={stockValueSupplierId} onChange={setStockValueSupplierId} options={stockValueSupplierOptions} />
              </div>
              <div className={css.filterfield}>
                <label>Valuation Basis</label>
                <ReportSelect ariaLabel="Valuation Basis" value={stockValueBasis} onChange={(v) => setStockValueBasis(v as ValuationBasis)} options={VALUATION_BASIS_OPTIONS} />
              </div>
            </>
          ) : report === "stock-health" ? (
            <>
              <div className={css.filterfield}>
                <label>Category</label>
                <ReportSelect ariaLabel="Category" value={deadStockCategoryId} onChange={setDeadStockCategoryId} options={stockValueCategoryOptions} />
              </div>
              <div className={css.filterfield}>
                <label>Supplier</label>
                <ReportSelect ariaLabel="Supplier" value={deadStockSupplierId} onChange={setDeadStockSupplierId} options={stockValueSupplierOptions} />
              </div>
            </>
          ) : report === "stock-movement" ? (
            <>
              <div className={css.filterfield}>
                <label>Category</label>
                <ReportSelect ariaLabel="Category" value={movementCategoryId} onChange={setMovementCategoryId} options={stockValueCategoryOptions} />
              </div>
              <div className={css.filterfield}>
                <label>Supplier</label>
                <ReportSelect ariaLabel="Supplier" value={movementSupplierId} onChange={setMovementSupplierId} options={stockValueSupplierOptions} />
              </div>
              <div className={css.filterfield}>
                <label>Movement Type</label>
                <ReportSelect ariaLabel="Movement Type" value={movementTypeFilter} onChange={setMovementTypeFilter} options={MOVEMENT_TYPE_OPTIONS} />
              </div>
            </>
          ) : report === "expiry-batch-risk" ? (
            <>
              <div className={css.filterfield}>
                <label>
                  Sub-category{" "}
                  <span
                    className={css.oppInfoIcon}
                    data-tooltip="Scoped to Medicines and its sub-categories — the primary driver of expiry risk in pharmacy inventory. Other departments aren't shown here."
                  >
                    <IconInfo size={13} />
                  </span>
                </label>
                <ReportSelect ariaLabel="Sub-category" value={expiryCategoryId} onChange={setExpiryCategoryId} options={expiryCategoryOptions} />
              </div>
              <div className={css.filterfield}>
                <label>Supplier</label>
                <ReportSelect ariaLabel="Supplier" value={expirySupplierId} onChange={setExpirySupplierId} options={expirySupplierOptions} />
              </div>
            </>
          ) : undefined
        }
        onReset={resetFilters}
        onExportCsv={() => exportPayload && exportRowsToCsv(exportPayload.filename, exportPayload.headers, exportPayload.rows)}
        exportDisabled={!exportPayload}
        onPrint={handlePrint}
      />

      {SYNC_SENSITIVE_CATEGORIES.has(category) && !(activeCategory.comingSoon || activeReport?.comingSoon) ? (
        <SyncFreshnessNotice
          days={period}
          scope={scope}
          isOwner={isOwner}
          everyBranch={EVERY_BRANCH_REPORTS.has(report)}
        />
      ) : null}

      {activeCategory.comingSoon || activeReport?.comingSoon ? (
        <ComingSoonPanel label={activeReport?.label ?? activeCategory.label} />
      ) : report === "sales-summary" ? (
        <SalesSection key={report} scope={scope} isOwner={isOwner} branchId={branchId} days={period} onNavigate={navigate} onExportData={setExportPayload} dims={dims} />
      ) : report === "product-sales" ? (
        <ProductSalesSection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "category-sales" ? (
        <CategorySalesSection
          key={report}
          scope={scope}
          isOwner={isOwner}
          days={period}
          onNavigate={navigate}
          onExportData={setExportPayload}
          groupBy={categoryGroupBy}
          excludeUnclassified={excludeUnclassified}
          dims={dims}
        />
      ) : report === "branch-sales" ? (
        <BranchSalesSection key={report} days={period} cityFilter={branchCity} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "cashier-performance" ? (
        <CashierPerformanceSection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} dims={dims} />
      ) : report === "payment-methods" ? (
        <PaymentMethodsSection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} dims={dims} />
      ) : report === "returns-discounts" ? (
        <ReturnsDiscountsSection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} dims={dims} />
      ) : report === "shift-cash" ? (
        <ShiftCashSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "gross-profit" ? (
        <GrossProfitSection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "margin-by-product" ? (
        <ProfitabilitySection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "margin-by-category" ? (
        <MarginByCategorySection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "branch-profitability" ? (
        <BranchProfitabilitySection key={report} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "expiry-batch-risk" ? (
        <NearExpirySection
          key={report}
          scope={scope}
          isOwner={isOwner}
          days={period}
          categoryId={expiryCategoryId === "all" ? undefined : expiryCategoryId}
          supplierId={expirySupplierId === "all" ? undefined : expirySupplierId}
          isMultiBranch={branches.length > 1}
          currentBranchName={currentBranch?.name}
          onExportData={setExportPayload}
        />
      ) : report === "inventory-summary" ? (
        <InventorySummarySection
          key={report}
          scope={scope}
          isOwner={isOwner}
          categoryId={stockValueCategoryId === "all" ? undefined : stockValueCategoryId}
          supplierId={stockValueSupplierId === "all" ? undefined : stockValueSupplierId}
          valuationBasis={stockValueBasis}
          onExportData={setExportPayload}
        />
      ) : report === "stock-health" ? (
        <StockHealthSection
          key={report}
          scope={scope}
          isOwner={isOwner}
          categoryId={deadStockCategoryId === "all" ? undefined : deadStockCategoryId}
          supplierId={deadStockSupplierId === "all" ? undefined : deadStockSupplierId}
          onExportData={setExportPayload}
        />
      ) : report === "stock-movement" ? (
        <StockMovementSection
          key={report}
          scope={scope}
          isOwner={isOwner}
          days={period}
          categoryId={movementCategoryId === "all" ? undefined : movementCategoryId}
          supplierId={movementSupplierId === "all" ? undefined : movementSupplierId}
          movementType={movementTypeFilter === "all" ? undefined : (movementTypeFilter as MovementTypeFilterKey)}
          onExportData={setExportPayload}
        />
      ) : report === "transfers-report" ? (
        <TransfersReportSection key={report} days={period} onExportData={setExportPayload} />
      ) : report === "stocktakes-report" ? (
        <StocktakesReportSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "purchase-summary" ? (
        <PurchaseSummarySection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "supplier-spend" ? (
        <SupplierSpendSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "supplier-performance" ? (
        <SupplierPerformanceSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : (
        <ComingSoonPanel label={activeReport?.label ?? "This report"} />
      )}
    </div>
  );
}
