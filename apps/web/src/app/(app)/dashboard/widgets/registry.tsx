import { BusinessOverviewPanel } from "../components/business-overview-panel";
import { CashFlowPanel } from "../components/cash-flow-panel";
import { BranchSalesTrendPanel } from "../components/branch-sales-trend-panel";
import { TopSuppliersPanel } from "../components/top-suppliers-panel";
import { CustomerBreakdownPanel } from "../components/customer-breakdown-panel";
import { FootfallPanel } from "../components/footfall-panel";
import { StockMovementTrendPanel } from "../components/stock-movement-trend-panel";
import { OwnerPendingApprovalsWidget } from "./owner-pending-approvals";
import { OwnerBranchRevenueContributionWidget } from "./owner-branch-revenue-contribution";
import { OwnerInventoryHealthWidget } from "./owner-inventory-health";
import { OwnerAiInsightsWidget } from "./owner-ai-insights";
import { OwnerTeamBranchSnapshotWidget } from "./owner-team-branch-snapshot";
import { ManagerInventoryHealthWidget } from "./manager-inventory-health";
import { ManagerBranchSalesVsTargetWidget } from "./manager-branch-sales-vs-target";
import { ManagerStaffProductivityWidget } from "./manager-staff-productivity";
import { ManagerTransferPoPipelineWidget } from "./manager-transfer-po-pipeline";
import { ManagerTopProductsTodayWidget } from "./manager-top-products-today";
import { ManagerPendingApprovalsWidget } from "./manager-pending-approvals";
import { ManagerAiInsightsWidget } from "./manager-ai-insights";
import { PharmacistPrescriptionQueueWidget } from "./pharmacist-prescription-queue";
import { PharmacistDrugInteractionWidget } from "./pharmacist-drug-interaction";
import { PharmacistDispensingThroughputWidget } from "./pharmacist-dispensing-throughput";
import { PharmacistControlledDrugActivityWidget } from "./pharmacist-controlled-drug-activity";
import { PharmacistFrequentlyDispensedWidget } from "./pharmacist-frequently-dispensed";
import { PharmacistBatchExpiryMonitorWidget } from "./pharmacist-batch-expiry-monitor";
import { PharmacistStockWatchWidget } from "./pharmacist-stock-watch";
import { PharmacistAiInsightsWidget } from "./pharmacist-ai-insights";
import { CashierShiftPerformanceWidget } from "./cashier-shift-performance";
import { CashierPaymentMethodsWidget } from "./cashier-payment-methods";
import { CashierHeldBillsWidget } from "./cashier-held-bills";
import { CashierFastMovingItemsWidget } from "./cashier-fast-moving-items";
import { CashierRecentTransactionsWidget } from "./cashier-recent-transactions";
import { CashierAiInsightsWidget } from "./cashier-ai-insights";
import { InventoryClerkInventoryHealthWidget } from "./inventory-clerk-inventory-health";
import { InventoryClerkExpiryWatchWidget } from "./inventory-clerk-expiry-watch";
import { InventoryClerkPendingPosWidget } from "./inventory-clerk-pending-pos";
import { InventoryClerkStockWatchWidget } from "./inventory-clerk-stock-watch";
import { InventoryClerkStocktakesWidget } from "./inventory-clerk-stocktakes";
import { InventoryClerkAiInsightsWidget } from "./inventory-clerk-ai-insights";
import type { WidgetDef } from "./types";
import type { DashboardRole } from "../lib/dashboard-role";

/** Every widget available today, across all 5 roles. Phase A: each role's
 * inline panels were extracted verbatim (see widgets/*.tsx) — one registry
 * entry per role's exact current panel, not shared/parameterized across
 * roles, so today's per-role appearance can't regress. The few components
 * that were already role-agnostic (self-fetching panels, AI-insights body)
 * are reused via a one-line adapter instead of being re-extracted. */
export const WIDGET_REGISTRY: WidgetDef[] = [
  // ── Owner ──
  {
    key: "owner.business-overview",
    title: "Business Overview",
    roles: ["owner"],
    category: "Overview",
    width: "wide",
    rows: 16,
    component: ({ data }) => (
      <BusinessOverviewPanel fallbackTrend={data.salesTrend7d} analyticsBranchId={data.analyticsBranchId} />
    ),
  },
  {
    key: "owner.cash-flow",
    title: "Cash Flow",
    roles: ["owner"],
    category: "Overview",
    width: "narrow",
    rows: 12,
    component: ({ data }) => <CashFlowPanel analyticsBranchId={data.analyticsBranchId} />,
  },
  {
    key: "owner.branch-sales-trend",
    title: "Branch Sales Trend",
    roles: ["owner"],
    category: "Overview",
    width: "wide",
    rows: 23,
    component: () => <BranchSalesTrendPanel />,
  },
  {
    key: "owner.top-suppliers",
    title: "Top Suppliers",
    roles: ["owner"],
    category: "Purchasing",
    width: "narrow",
    rows: 17,
    component: () => (
      <TopSuppliersPanel
        footerHref="/reports?category=purchasing&report=supplier-performance"
        footerLabel="View supplier performance →"
      />
    ),
  },
  {
    key: "owner.pending-approvals",
    title: "Pending Approvals",
    roles: ["owner"],
    category: "Operations",
    width: "narrow",
    rows: 16,
    component: OwnerPendingApprovalsWidget,
  },
  {
    key: "owner.branch-revenue-contribution",
    title: "Branch Revenue Contribution",
    roles: ["owner"],
    category: "Overview",
    width: "narrow",
    rows: 14,
    component: OwnerBranchRevenueContributionWidget,
  },
  {
    key: "owner.inventory-health",
    title: "Inventory Health",
    roles: ["owner"],
    category: "Inventory",
    width: "narrow",
    rows: 16,
    component: OwnerInventoryHealthWidget,
  },
  {
    key: "owner.ai-insights",
    title: "AI Insights",
    roles: ["owner"],
    category: "Insights",
    width: "narrow",
    rows: 18,
    component: OwnerAiInsightsWidget,
  },
  {
    key: "owner.team-branch-snapshot",
    title: "Team & Branch Snapshot",
    roles: ["owner"],
    category: "Overview",
    width: "narrow",
    rows: 18,
    component: OwnerTeamBranchSnapshotWidget,
  },

  // ── Manager ──
  {
    key: "manager.business-overview",
    title: "Branch Performance Overview",
    roles: ["manager"],
    category: "Overview",
    width: "wide",
    rows: 16,
    component: ({ data }) => (
      <BusinessOverviewPanel
        title="Branch Performance Overview"
        fallbackTrend={data.salesTrend7d}
        analyticsBranchId={data.branchId}
      />
    ),
  },
  {
    key: "manager.inventory-health",
    title: "Inventory Health",
    roles: ["manager"],
    category: "Inventory",
    width: "narrow",
    rows: 16,
    component: ManagerInventoryHealthWidget,
  },
  {
    key: "manager.branch-sales-vs-target",
    title: "Branch Sales vs Target",
    roles: ["manager"],
    category: "Overview",
    width: "narrow",
    rows: 18,
    component: ManagerBranchSalesVsTargetWidget,
  },
  {
    key: "manager.staff-productivity",
    title: "Staff Productivity",
    roles: ["manager"],
    category: "Operations",
    width: "narrow",
    rows: 19,
    component: ManagerStaffProductivityWidget,
  },
  {
    key: "manager.customer-breakdown",
    title: "Today's Customer Breakdown",
    roles: ["manager"],
    category: "Overview",
    width: "narrow",
    rows: 16,
    component: ({ data }) => <CustomerBreakdownPanel branchId={data.branchId} />,
  },
  {
    key: "manager.transfer-po-pipeline",
    title: "Transfer & PO Pipeline",
    roles: ["manager"],
    category: "Operations",
    width: "narrow",
    rows: 18,
    component: ManagerTransferPoPipelineWidget,
  },
  {
    key: "manager.top-products-today",
    title: "Top Products Today",
    roles: ["manager"],
    category: "Sales",
    width: "narrow",
    rows: 16,
    component: ManagerTopProductsTodayWidget,
  },
  {
    key: "manager.footfall",
    title: "Footfall",
    roles: ["manager"],
    category: "Overview",
    width: "narrow",
    rows: 18,
    component: ({ data }) => <FootfallPanel branchId={data.branchId} />,
  },
  {
    key: "manager.ai-insights",
    title: "AI Insights",
    roles: ["manager"],
    category: "Insights",
    width: "narrow",
    rows: 18,
    component: ManagerAiInsightsWidget,
  },
  {
    key: "manager.pending-approvals",
    title: "Pending Approvals",
    roles: ["manager"],
    category: "Operations",
    width: "narrow",
    rows: 16,
    component: ManagerPendingApprovalsWidget,
  },

  // ── Pharmacist ──
  {
    key: "pharmacist.prescription-queue",
    title: "Prescription Verification Queue",
    roles: ["pharmacist"],
    category: "Dispensing",
    width: "wide",
    rows: 12,
    component: PharmacistPrescriptionQueueWidget,
  },
  {
    key: "pharmacist.drug-interaction",
    title: "Drug Interaction / CDS",
    roles: ["pharmacist"],
    category: "Clinical",
    width: "narrow",
    rows: 13,
    component: PharmacistDrugInteractionWidget,
  },
  {
    key: "pharmacist.dispensing-throughput",
    title: "Dispensing Throughput (Today)",
    roles: ["pharmacist"],
    category: "Dispensing",
    width: "narrow",
    rows: 15,
    component: PharmacistDispensingThroughputWidget,
  },
  {
    key: "pharmacist.controlled-drug-activity",
    title: "Controlled Drug Activity",
    roles: ["pharmacist"],
    category: "Clinical",
    width: "narrow",
    rows: 12,
    component: PharmacistControlledDrugActivityWidget,
  },
  {
    key: "pharmacist.frequently-dispensed",
    title: "Frequently Dispensed",
    roles: ["pharmacist"],
    category: "Dispensing",
    width: "narrow",
    rows: 15,
    component: PharmacistFrequentlyDispensedWidget,
  },
  {
    key: "pharmacist.batch-expiry-monitor",
    title: "Batch & Expiry Monitor",
    roles: ["pharmacist"],
    category: "Inventory",
    width: "narrow",
    rows: 19,
    component: PharmacistBatchExpiryMonitorWidget,
  },
  {
    key: "pharmacist.stock-watch",
    title: "Stock Watch — Therapeutic Essentials",
    roles: ["pharmacist"],
    category: "Inventory",
    width: "narrow",
    rows: 16,
    component: PharmacistStockWatchWidget,
  },
  {
    key: "pharmacist.ai-insights",
    title: "AI Clinical Insights",
    roles: ["pharmacist"],
    category: "Insights",
    width: "narrow",
    rows: 13,
    component: PharmacistAiInsightsWidget,
  },

  // ── Cashier ──
  {
    key: "cashier.shift-performance",
    title: "Shift Performance (Today)",
    roles: ["cashier"],
    category: "Overview",
    width: "wide",
    rows: 24,
    component: CashierShiftPerformanceWidget,
  },
  {
    key: "cashier.payment-methods",
    title: "Payment Methods Today",
    roles: ["cashier"],
    category: "Sales",
    width: "narrow",
    rows: 16,
    component: CashierPaymentMethodsWidget,
  },
  {
    key: "cashier.customer-breakdown",
    title: "Today's Customer Breakdown",
    roles: ["cashier"],
    category: "Overview",
    width: "narrow",
    rows: 16,
    component: ({ data }) => <CustomerBreakdownPanel branchId={data.branchId} />,
  },
  {
    key: "cashier.held-bills",
    title: "Held Bills",
    roles: ["cashier"],
    category: "Sales",
    width: "narrow",
    rows: 21,
    component: CashierHeldBillsWidget,
  },
  {
    key: "cashier.fast-moving-items",
    title: "Fast Moving Counter Items",
    roles: ["cashier"],
    category: "Sales",
    width: "narrow",
    rows: 15,
    component: CashierFastMovingItemsWidget,
  },
  {
    key: "cashier.recent-transactions",
    title: "Recent Transactions",
    roles: ["cashier"],
    category: "Sales",
    width: "narrow",
    rows: 23,
    component: CashierRecentTransactionsWidget,
  },
  {
    key: "cashier.ai-insights",
    title: "AI Insights",
    roles: ["cashier"],
    category: "Insights",
    width: "narrow",
    rows: 13,
    component: CashierAiInsightsWidget,
  },

  // ── Inventory Clerk ──
  {
    key: "inventory_clerk.stock-movement-trend",
    title: "Stock Movement Trend",
    roles: ["inventory_clerk"],
    category: "Inventory",
    width: "wide",
    rows: 15,
    component: ({ data }) => <StockMovementTrendPanel branchId={data.branchId} />,
  },
  {
    key: "inventory_clerk.inventory-health",
    title: "Inventory Health",
    roles: ["inventory_clerk"],
    category: "Inventory",
    width: "narrow",
    rows: 16,
    component: InventoryClerkInventoryHealthWidget,
  },
  {
    key: "inventory_clerk.expiry-watch",
    title: "Expiry Watch",
    roles: ["inventory_clerk"],
    category: "Inventory",
    width: "narrow",
    rows: 19,
    component: InventoryClerkExpiryWatchWidget,
  },
  {
    key: "inventory_clerk.pending-pos",
    title: "Pending POs",
    roles: ["inventory_clerk"],
    category: "Purchasing",
    width: "narrow",
    rows: 17,
    component: InventoryClerkPendingPosWidget,
  },
  {
    key: "inventory_clerk.stock-watch",
    title: "Stock Watch",
    roles: ["inventory_clerk"],
    category: "Inventory",
    width: "narrow",
    rows: 19,
    component: InventoryClerkStockWatchWidget,
  },
  {
    key: "inventory_clerk.top-suppliers",
    title: "Top Suppliers",
    roles: ["inventory_clerk"],
    category: "Purchasing",
    width: "narrow",
    rows: 17,
    component: () => <TopSuppliersPanel />,
  },
  {
    key: "inventory_clerk.stocktakes",
    title: "Stocktakes",
    roles: ["inventory_clerk"],
    category: "Inventory",
    width: "narrow",
    rows: 16,
    component: InventoryClerkStocktakesWidget,
  },
  {
    key: "inventory_clerk.ai-insights",
    title: "AI Insights",
    roles: ["inventory_clerk"],
    category: "Insights",
    width: "narrow",
    rows: 13,
    component: InventoryClerkAiInsightsWidget,
  },
];

export function catalogForRole(role: DashboardRole): WidgetDef[] {
  return WIDGET_REGISTRY.filter((w) => w.roles.includes(role));
}
