"use client";

import { useMemo, useState } from "react";
import { useReportsFilters } from "../lib/use-reports-filters";
import { categoryDef, reportDef } from "../lib/nav-config";
import { CategoryNav } from "./category-nav";
import { FilterBar } from "./filter-bar";
import { ReportSelect } from "./report-select";
import { ComingSoonPanel } from "./coming-soon-panel";
import { SalesSection } from "../sections/sales-section";
import { ProductSalesSection } from "../sections/product-sales-section";
import { CategorySalesSection } from "../sections/category-sales-section";
import { BranchSalesSection } from "../sections/branch-sales-section";
import { CashierPerformanceSection } from "../sections/cashier-performance-section";
import { PaymentMethodsSection } from "../sections/payment-methods-section";
import { ReturnsDiscountsSection } from "../sections/returns-discounts-section";
import { GrossProfitSection } from "../sections/gross-profit-section";
import { ProfitabilitySection } from "../sections/profitability-section";
import { MarginByCategorySection } from "../sections/margin-by-category-section";
import { LowMarginSection } from "../sections/low-margin-section";
import { NearExpirySection } from "../sections/near-expiry-section";
import { DeadStockSection } from "../sections/dead-stock-section";
import { StockValueSection } from "../sections/stock-value-section";
import { exportRowsToCsv } from "../lib/csv";
import type { CategoryGroupBy, ExportPayload } from "../lib/types";
import css from "../reports.module.css";

const MARGIN_THRESHOLD_OPTIONS = [
  { value: "15", label: "< 15%" },
  { value: "20", label: "< 20%" },
  { value: "30", label: "< 30%" },
];

const CATEGORY_GROUP_BY_OPTIONS: { value: CategoryGroupBy; label: string }[] = [
  { value: "commercial", label: "Commercial Category" },
  { value: "dosageForm", label: "Dosage Form" },
  { value: "schedule", label: "Schedule" },
  { value: "registrationType", label: "Registration Type" },
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
  "low-margin-products",
]);

export function ReportsWorkspace() {
  const filters = useReportsFilters();
  const { category, report, navigate, scope, setScope, isOwner, branchId, setBranchId, branches } = filters;

  const activeCategory = categoryDef(category);
  const activeReport = reportDef(category, report);

  const [periods, setPeriods] = useState<Record<string, number>>({});
  const [exportPayload, setExportPayload] = useState<ExportPayload | null>(null);
  const [branchCity, setBranchCity] = useState<string>("all");
  const [marginThreshold, setMarginThreshold] = useState<number>(20);
  const [categoryGroupBy, setCategoryGroupBy] = useState<CategoryGroupBy>("commercial");
  const [excludeUnclassified, setExcludeUnclassified] = useState(false);
  const period = periods[report] ?? activeReport?.defaultPeriod ?? 30;
  const setPeriod = (n: number) => setPeriods((prev) => ({ ...prev, [report]: n }));

  const scopeDisabled = report === "near-expiry";

  const cityOptions = useMemo(
    () => [...new Set(branches.map((b) => b.city).filter((c): c is string => !!c))].sort(),
    [branches],
  );

  function resetFilters() {
    setScope("branch");
    if (activeReport?.defaultPeriod != null) setPeriod(activeReport.defaultPeriod);
    setBranchCity("all");
    setMarginThreshold(20);
    setCategoryGroupBy("commercial");
    setExcludeUnclassified(false);
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div className={css.page}>
      <p style={{ margin: "0 0 0.6rem", fontSize: "0.83rem", color: "var(--pc-muted-fg)" }}>
        Performance, profitability, and stock risk insights for smarter decisions.
      </p>

      <CategoryNav category={category} report={report} onNavigate={navigate} />

      <FilterBar
        branches={branches}
        branchId={branchId}
        onBranchChange={setBranchId}
        isOwner={isOwner}
        scope={scope}
        onScopeChange={setScope}
        hideBranchScope={report === "branch-sales"}
        scopeDisabled={scopeDisabled}
        scopeDisabledNote={scopeDisabled ? "Near-expiry stock is always specific to the branch above." : undefined}
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
            </>
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
          ) : report === "low-margin-products" ? (
            <div className={css.filterfield}>
              <label>Margin Threshold</label>
              <ReportSelect
                ariaLabel="Margin Threshold"
                value={String(marginThreshold)}
                onChange={(v) => setMarginThreshold(Number(v))}
                options={MARGIN_THRESHOLD_OPTIONS}
              />
            </div>
          ) : undefined
        }
        onReset={resetFilters}
        onExportCsv={() => exportPayload && exportRowsToCsv(exportPayload.filename, exportPayload.headers, exportPayload.rows)}
        exportDisabled={!exportPayload}
        onPrint={handlePrint}
      />

      {activeCategory.comingSoon || activeReport?.comingSoon ? (
        <ComingSoonPanel label={activeReport?.label ?? activeCategory.label} />
      ) : report === "sales-summary" ? (
        <SalesSection key={report} scope={scope} isOwner={isOwner} branchId={branchId} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "product-sales" ? (
        <ProductSalesSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "category-sales" ? (
        <CategorySalesSection
          key={report}
          scope={scope}
          isOwner={isOwner}
          days={period}
          onExportData={setExportPayload}
          groupBy={categoryGroupBy}
          excludeUnclassified={excludeUnclassified}
        />
      ) : report === "branch-sales" ? (
        <BranchSalesSection key={report} days={period} cityFilter={branchCity} onExportData={setExportPayload} />
      ) : report === "cashier-performance" ? (
        <CashierPerformanceSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "payment-methods" ? (
        <PaymentMethodsSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "returns-discounts" ? (
        <ReturnsDiscountsSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "gross-profit" ? (
        <GrossProfitSection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "margin-by-product" ? (
        <ProfitabilitySection key={report} scope={scope} isOwner={isOwner} days={period} onNavigate={navigate} onExportData={setExportPayload} />
      ) : report === "margin-by-category" ? (
        <MarginByCategorySection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "low-margin-products" ? (
        <LowMarginSection key={report} scope={scope} isOwner={isOwner} days={period} threshold={marginThreshold} onExportData={setExportPayload} />
      ) : report === "near-expiry" ? (
        <NearExpirySection key={report} branchId={branchId} withinDays={period} onExportData={setExportPayload} />
      ) : report === "dead-stock" ? (
        <DeadStockSection key={report} scope={scope} isOwner={isOwner} days={period} onExportData={setExportPayload} />
      ) : report === "stock-value" ? (
        <StockValueSection key={report} scope={scope} isOwner={isOwner} onExportData={setExportPayload} />
      ) : (
        <ComingSoonPanel label={activeReport?.label ?? "This report"} />
      )}
    </div>
  );
}
