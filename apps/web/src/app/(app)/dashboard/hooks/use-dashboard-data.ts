"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventorySummary, MovementRow } from "@/app/(app)/inventory/types";
import type { PurchaseOrderListItem } from "@/app/(app)/purchasing/types";
import { isPoOverdue } from "@/app/(app)/purchasing/utils";
import { apiJson, fetchTenantBranches, type TenantBranch } from "@/lib/auth-client";
import {
  INSIGHTS_ROLES,
  OPERATIONS_ROLES,
  POS_ROLES,
  PURCHASING_ROLES,
  RETURNS_ROLES,
  STOCKTAKE_ROLES,
} from "@/lib/role-access";
import { useAuth } from "@/lib/use-auth";
import { useRoleAccess } from "@/lib/use-role-access";
import type { ChartPoint, SeriesPoint } from "../components/simple-charts";
import { PLACEHOLDER_PAYMENT_MIX } from "../lib/placeholder-data";
import { paymentMixColor } from "../lib/payment-mix-colors";

export type SaleRow = {
  id: string;
  invoiceNo: string;
  soldAt: string;
  grandTotal: string;
  status?: string;
  customer?: { id: string; fullName: string; phone: string | null } | null;
  payments?: Array<{ method: string; amount: string }>;
  items: Array<{ qty: number; product: { name: string; sku: string } }>;
  seller?: { id: string; fullName: string } | null;
};

export type BranchPerformanceRow = {
  branchId: string;
  code: string;
  name: string;
  city: string | null;
  todaySales: number;
  todayTxnCount: number;
  monthSales: number;
  monthTxnCount: number;
  targetAmount: number | null;
  achievementPct: number | null;
  vsPrevMonthPct: number | null;
  manager: { id: string; fullName: string; email: string } | null;
  targetId: string | null;
};

export type FinancialSnapshot = {
  receivablesOutstanding: number;
  receivablesCustomerCount: number;
  receivablesNote: string;
  payablesOutstanding: number;
  payablesSupplierCount: number;
};

export type SalesPulse = {
  todaySales: number;
  todayTxnCount: number;
  yesterdaySales: number;
  vsYesterdayPct: number | null;
  salesTrend7d: Array<{ label: string; date: string; value: number }>;
  paymentMix: Array<{ method: string; value: number }>;
  /** Σ Sale.grandTotal for paymentMixScope window (donut center / revenue parity). */
  paymentMixTotal: number;
  paymentMixScope: "today" | "this_week" | "this_month";
  scope?: "tenant" | "branch";
  branchId?: string | null;
};

export type OpsSnapshot = {
  scope: "tenant" | "branch";
  branchId: string | null;
  lowStock: number;
  outOfStock: number;
  nearExpiry: number;
  stockValue: number;
  openPoCount: number;
  openPoValue: number;
  pendingApproval: number;
  overduePos: number;
  controlledLowStock: number;
  controlledNearExpiry: number;
  controlledAttentionCount: number;
};

export type InventoryImprovement = {
  scope: "tenant" | "branch";
  branchId: string | null;
  days: number;
  asOf: string;
  comparedTo: string;
  improvedCount: number;
  worsenedCount: number;
  attentionNow: number;
  attentionPrev: number;
  attentionDelta: number;
};

/** Owner dashboard metric filter — default is tenant-wide. */
export type OwnerAnalyticsScope = "all_branches" | "this_branch";

export const OWNER_SCOPE_OPTIONS = [
  { value: "all_branches", label: "All branches" },
  { value: "this_branch", label: "This branch" },
] as const;

function withAnalyticsBranch(path: string, branchId: string | null | undefined): string {
  if (!branchId) return path;
  const qs = `branchId=${encodeURIComponent(branchId)}`;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

type SalesSummary = {
  days: number;
  count: number;
  grandTotal: string;
};

type ReorderResponse = {
  items: Array<{
    sku: string;
    name: string;
    onHand: number;
    suggestedQty: number;
    reorderLevel?: number;
  }>;
};

type HoldRow = {
  id: string;
  holdRef: string;
  label: string | null;
  itemCount: number;
  total: string;
  createdAt: string;
  heldByName: string;
  needsPharmacist: boolean;
};

type TransferRow = {
  id: string;
  transferNumber: string;
  status: string;
  createdAt?: string;
  fromBranch?: { name: string };
  toBranch?: { name: string };
};

type ReturnRow = {
  id: string;
  returnNumber: string;
  status: string;
  type?: string;
};

type StocktakeRow = {
  id: string;
  stocktakeNumber?: string;
  status: string;
  name?: string;
};

type PrescriptionRow = {
  id: string;
  rxNumber: string;
  patientName: string;
  doctorName: string | null;
  createdAt: string;
};

type MarginRow = {
  productId: string;
  sku: string;
  name: string;
  revenue: string;
  cost: string;
  margin: string;
};

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function formatPct(n: number | null): string | undefined {
  if (n == null || Number.isNaN(n)) return undefined;
  // StatCard renders direction via arrow icons — omit the sign here.
  return `${Math.abs(n).toFixed(1)}%`;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

const OWNER_SCOPE_LS_KEY = "pharmacylon.dashboard.ownerOverviewScope";

function readStoredOwnerScope(): OwnerAnalyticsScope {
  if (typeof window === "undefined") return "all_branches";
  try {
    const raw = window.localStorage.getItem(OWNER_SCOPE_LS_KEY);
    if (raw === "this_branch" || raw === "all_branches") return raw;
    // Legacy keys from intermediate drafts
    if (raw === "branch") return "this_branch";
    if (raw === "tenant") return "all_branches";
  } catch {
    /* ignore */
  }
  return "all_branches";
}

export function useDashboardData() {
  const { branchId, user } = useAuth();
  const { canAccess, userRoles } = useRoleAccess();

  const canViewPurchasing = canAccess(PURCHASING_ROLES);
  const canViewReports = canAccess(["owner", "manager", "analyst"]);
  const canViewInsights = canAccess(INSIGHTS_ROLES);
  const canViewPos = canAccess(POS_ROLES);
  const canViewOps = canAccess(OPERATIONS_ROLES);
  const canViewReturns = canAccess(RETURNS_ROLES);
  const canViewStocktakes = canAccess(STOCKTAKE_ROLES);

  const [inventory, setInventory] = useState<InventorySummary | null>(null);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [salesSummary, setSalesSummary] = useState<SalesSummary | null>(null);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderListItem[]>([]);
  const [reorder, setReorder] = useState<ReorderResponse | null>(null);
  const [holds, setHolds] = useState<HoldRow[]>([]);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [goodsReturns, setGoodsReturns] = useState<ReturnRow[]>([]);
  const [stocktakes, setStocktakes] = useState<StocktakeRow[]>([]);
  const [prescriptions, setPrescriptions] = useState<PrescriptionRow[]>([]);
  const [nearExpiryItems, setNearExpiryItems] = useState<
    Array<{
      batchId: string;
      batchNo: string;
      expiryDate: string;
      qtyOnHand: number;
      productId: string;
      product: { sku: string; name: string; isControlled: boolean };
    }>
  >([]);
  const [marginByProduct, setMarginByProduct] = useState<MarginRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [lowStockRows, setLowStockRows] = useState<
    Array<{
      productId: string;
      qtyOnHand: number;
      product: { sku: string; name: string; reorderLevel: number; isControlled: boolean };
    }>
  >([]);
  const [controlledAttentionRows, setControlledAttentionRows] = useState<
    Array<{
      productId: string;
      qtyOnHand: number;
      product: { sku: string; name: string; reorderLevel: number; isControlled: boolean };
    }>
  >([]);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const [branchPerformance, setBranchPerformance] = useState<BranchPerformanceRow[]>([]);
  const [branchPerfYearMonth, setBranchPerfYearMonth] = useState<string | null>(null);
  const [financial, setFinancial] = useState<FinancialSnapshot | null>(null);
  const [salesPulse, setSalesPulse] = useState<SalesPulse | null>(null);
  const [opsSnapshot, setOpsSnapshot] = useState<OpsSnapshot | null>(null);
  const [inventoryImprovement, setInventoryImprovement] =
    useState<InventoryImprovement | null>(null);
  const [deadStockCount, setDeadStockCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const canViewAnalyticsWide = canAccess(["owner", "manager", "analyst"]);
  const isOwner = userRoles.includes("owner");

  /** Owner-only: default all branches; "this_branch" uses shell active branch. */
  const [ownerScope, setOwnerScopeState] =
    useState<OwnerAnalyticsScope>("all_branches");

  useEffect(() => {
    setOwnerScopeState(readStoredOwnerScope());
  }, []);

  const setOwnerScope = useCallback((scope: OwnerAnalyticsScope) => {
    setOwnerScopeState(scope);
    try {
      window.localStorage.setItem(OWNER_SCOPE_LS_KEY, scope);
    } catch {
      /* ignore */
    }
  }, []);

  const ownerBranchFilter =
    isOwner && ownerScope === "this_branch" ? branchId : null;
  /** Branch id query for analytics APIs (Owner all-branch = omit). */
  const analyticsBranchId = isOwner
    ? ownerBranchFilter
    : canViewAnalyticsWide
      ? branchId
      : null;

  const reload = useCallback(async () => {
    if (!branchId) {
      setInventory(null);
      setSales([]);
      setSalesSummary(null);
      setPurchaseOrders([]);
      setReorder(null);
      setHolds([]);
      setTransfers([]);
      setGoodsReturns([]);
      setStocktakes([]);
      setPrescriptions([]);
      setNearExpiryItems([]);
      setMarginByProduct([]);
      setMovements([]);
      setLowStockRows([]);
      setControlledAttentionRows([]);
      setBranches([]);
      setBranchPerformance([]);
      setBranchPerfYearMonth(null);
      setFinancial(null);
      setSalesPulse(null);
      setOpsSnapshot(null);
      setInventoryImprovement(null);
      setDeadStockCount(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const tasks: Promise<void>[] = [
        apiJson<InventorySummary>("/inventory/summary?period=this_month").then(setInventory),
        apiJson<SaleRow[]>("/sales").then(setSales),
        fetchTenantBranches()
          .then(setBranches)
          .catch(() => setBranches([])),
      ];

      // Near-expiry batches — inventory endpoint is available to more roles than /reports.
      tasks.push(
        apiJson<
          Array<{
            id: string;
            batchNo: string;
            expiryDate: string;
            qtyOnHand: number;
            nearExpiry: boolean;
            expired: boolean;
            productId: string;
            product: { sku: string; name: string; isControlled: boolean };
          }>
        >("/inventory/batches?nearExpiryDays=30&includeZero=false")
          .then((rows) =>
            setNearExpiryItems(
              rows
                .filter((b) => b.nearExpiry || b.expired)
                .filter((b) => b.qtyOnHand > 0)
                .slice(0, 20)
                .map((b) => ({
                  batchId: b.id,
                  batchNo: b.batchNo,
                  expiryDate: b.expiryDate,
                  qtyOnHand: b.qtyOnHand,
                  productId: b.productId,
                  product: {
                    sku: b.product.sku,
                    name: b.product.name,
                    isControlled: Boolean(b.product.isControlled),
                  },
                })),
            ),
          )
          .catch(() => setNearExpiryItems([])),
      );

      if (canViewReports) {
        const reportScopeQs =
          isOwner && ownerScope === "all_branches" ? "&scope=tenant" : "";
        tasks.push(
          apiJson<SalesSummary>(`/reports/sales-summary?days=30${reportScopeQs}`).then(
            setSalesSummary,
          ),
          apiJson<MarginRow[]>(`/reports/margin-by-product?days=30${reportScopeQs}`)
            .then(setMarginByProduct)
            .catch(() => setMarginByProduct([])),
        );
      } else {
        setSalesSummary(null);
        setMarginByProduct([]);
      }

      if (canViewPurchasing) {
        tasks.push(
          apiJson<PurchaseOrderListItem[]>("/purchasing/purchase-orders").then(setPurchaseOrders),
        );
      } else {
        setPurchaseOrders([]);
      }

      if (canViewInsights) {
        tasks.push(
          apiJson<ReorderResponse>("/analytics/reorder-recommendations")
            .then(setReorder)
            .catch(() => setReorder(null)),
        );
      } else {
        setReorder(null);
      }

      if (canViewPos) {
        tasks.push(
          apiJson<HoldRow[]>("/sales/holds")
            .then(setHolds)
            .catch(() => setHolds([])),
          apiJson<PrescriptionRow[]>("/prescriptions?take=20")
            .then(setPrescriptions)
            .catch(() => setPrescriptions([])),
        );
      } else {
        setHolds([]);
        setPrescriptions([]);
      }

      // Stock-by-product is readable by cashier+; useful for counter / inventory dashboards.
      tasks.push(
        apiJson<{
          items: Array<{
            productId: string;
            qtyOnHand: number;
            stockStatus: string;
            product: { sku: string; name: string; reorderLevel: number; isControlled: boolean };
          }>;
        }>("/inventory/stock-by-product?ledgerOnly=1&take=40")
          .then((res) =>
            setLowStockRows(
              (res.items ?? [])
                .filter((r) => r.stockStatus === "low" || r.stockStatus === "out")
                .slice(0, 8)
                .map((r) => ({
                  productId: r.productId,
                  qtyOnHand: r.qtyOnHand,
                  product: {
                    sku: r.product.sku,
                    name: r.product.name,
                    reorderLevel: r.product.reorderLevel,
                    isControlled: Boolean(r.product.isControlled),
                  },
                })),
            ),
          )
          .catch(() => setLowStockRows([])),
        apiJson<{
          items: Array<{
            productId: string;
            qtyOnHand: number;
            stockStatus: string;
            product: { sku: string; name: string; reorderLevel: number; isControlled: boolean };
          }>;
        }>("/inventory/stock-by-product?controlled=controlled&ledgerOnly=1&take=40")
          .then((res) =>
            setControlledAttentionRows(
              (res.items ?? [])
                .filter((r) => r.stockStatus === "low" || r.stockStatus === "out")
                .slice(0, 12)
                .map((r) => ({
                  productId: r.productId,
                  qtyOnHand: r.qtyOnHand,
                  product: {
                    sku: r.product.sku,
                    name: r.product.name,
                    reorderLevel: r.product.reorderLevel,
                    isControlled: true,
                  },
                })),
            ),
          )
          .catch(() => setControlledAttentionRows([])),
      );

      if (canViewOps) {
        tasks.push(
          apiJson<TransferRow[]>("/transfers")
            .then(setTransfers)
            .catch(() => setTransfers([])),
          apiJson<{ items: MovementRow[] }>("/inventory/movements?take=12")
            .then((r) => setMovements(r.items ?? []))
            .catch(() => setMovements([])),
        );
      } else {
        setTransfers([]);
        setMovements([]);
      }

      if (canViewReturns) {
        tasks.push(
          apiJson<ReturnRow[]>("/returns")
            .then(setGoodsReturns)
            .catch(() => setGoodsReturns([])),
        );
      } else {
        setGoodsReturns([]);
      }

      if (canViewStocktakes) {
        tasks.push(
          apiJson<StocktakeRow[]>("/stocktakes")
            .then(setStocktakes)
            .catch(() => setStocktakes([])),
        );
      } else {
        setStocktakes([]);
      }

      if (canViewAnalyticsWide) {
        // Owner: omit branchId for all_branches; pass shell branch for this_branch.
        // Manager/analyst: always active branch.
        const scoped = (path: string) => withAnalyticsBranch(path, analyticsBranchId);

        tasks.push(
          apiJson<{
            yearMonth: string;
            branches: BranchPerformanceRow[];
          }>("/analytics/branch-performance")
            .then((res) => {
              setBranchPerfYearMonth(res.yearMonth);
              setBranchPerformance(res.branches ?? []);
            })
            .catch(() => {
              setBranchPerformance([]);
              setBranchPerfYearMonth(null);
            }),
          apiJson<FinancialSnapshot>(scoped("/analytics/financial-snapshot"))
            .then(setFinancial)
            .catch(() => setFinancial(null)),
          apiJson<SalesPulse>(scoped("/analytics/sales-pulse"))
            .then(setSalesPulse)
            .catch(() => setSalesPulse(null)),
          apiJson<OpsSnapshot>(scoped("/analytics/ops-snapshot"))
            .then(setOpsSnapshot)
            .catch(() => setOpsSnapshot(null)),
          apiJson<InventoryImprovement>(
            scoped("/analytics/inventory-improvement?days=7"),
          )
            .then(setInventoryImprovement)
            .catch(() => setInventoryImprovement(null)),
        );
      } else {
        setBranchPerformance([]);
        setBranchPerfYearMonth(null);
        setFinancial(null);
        setSalesPulse(null);
        setOpsSnapshot(null);
        setInventoryImprovement(null);
      }

      if (canViewReports) {
        const deadScopeQs =
          isOwner && ownerScope === "all_branches" ? "&scope=tenant" : "";
        tasks.push(
          apiJson<{ items: unknown[] }>(`/reports/dead-stock?days=90${deadScopeQs}`)
            .then((r) => setDeadStockCount(r.items?.length ?? 0))
            .catch(() => setDeadStockCount(null)),
        );
      } else {
        setDeadStockCount(null);
      }

      await Promise.all(tasks);
      setLastUpdatedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, [
    analyticsBranchId,
    branchId,
    canViewAnalyticsWide,
    canViewInsights,
    canViewOps,
    canViewPos,
    canViewPurchasing,
    canViewReports,
    canViewReturns,
    canViewStocktakes,
    isOwner,
    ownerScope,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const derived = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);

    const posted = sales.filter((s) => s.soldAt);
    const todaySales = posted.filter((s) => new Date(s.soldAt) >= startOfToday);
    const yesterdaySales = posted.filter((s) => {
      const d = new Date(s.soldAt);
      return d >= startOfYesterday && d < startOfToday;
    });
    const todayTotal = todaySales.reduce((sum, s) => sum + Number(s.grandTotal), 0);
    const yesterdayTotal = yesterdaySales.reduce((sum, s) => sum + Number(s.grandTotal), 0);
    const salesTrendPct = pctChange(todayTotal, yesterdayTotal);

    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const monthSales = posted.filter((s) => new Date(s.soldAt) >= thirtyDaysAgo);
    const monthTotalFromList = monthSales.reduce((sum, s) => sum + Number(s.grandTotal), 0);

    const openPoStatuses = new Set([
      "draft",
      "pending_approval",
      "issued",
      "partially_received",
    ]);
    const openPos = purchaseOrders.filter((po) => openPoStatuses.has(po.status));
    const overduePos = purchaseOrders.filter(isPoOverdue);
    const pendingApproval = purchaseOrders.filter((po) => po.status === "pending_approval");
    const openPoValue = openPos.reduce(
      (sum, po) =>
        sum +
        po.items.reduce((lineSum, item) => lineSum + Number(item.unitCost) * item.orderedQty, 0),
      0,
    );

    const returnsToday = posted.filter(
      (s) =>
        new Date(s.soldAt) >= startOfToday &&
        (s.status === "refunded" || s.status === "partially_refunded"),
    );
    // listSales filters to posted/partially_refunded — count partial refunds as returns signal
    const returnsTodayCount = returnsToday.length;
    const returnsTodayTotal = returnsToday.reduce((sum, s) => sum + Number(s.grandTotal), 0);

    // Hourly sales today for cashier/pharmacist charts
    const hourlyToday: ChartPoint[] = [];
    for (let h = 7; h <= 21; h++) {
      const total = todaySales
        .filter((s) => new Date(s.soldAt).getHours() === h)
        .reduce((sum, s) => sum + Number(s.grandTotal), 0);
      hourlyToday.push({ label: hourLabel(h), value: total });
    }

    // Hourly unit volume (dispense proxy) for pharmacist workload chart
    const hourlyUnitsToday: ChartPoint[] = [];
    for (let h = 7; h <= 21; h++) {
      const units = todaySales
        .filter((s) => new Date(s.soldAt).getHours() === h)
        .reduce((sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0), 0);
      hourlyUnitsToday.push({ label: hourLabel(h), value: units });
    }

    // Payment mix: prefer analytics pulse (tenant for Owner, branch for Manager/analyst)
    let paymentMix: Array<{ label: string; value: number; color: string }>;
    let paymentMixIsPlaceholder = false;
    let paymentMixLabel = "Today";

    if (salesPulse && salesPulse.paymentMix.length > 0 && canViewAnalyticsWide) {
      paymentMix = salesPulse.paymentMix.map((p) => ({
        label: p.method.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        value: p.value,
        color: paymentMixColor(p.method),
      }));
      paymentMixLabel =
        salesPulse.paymentMixScope === "today"
          ? "Today"
          : salesPulse.paymentMixScope === "this_week"
            ? "This week"
            : "This month";
    } else {
      const methodTotals = new Map<string, number>();
      for (const sale of todaySales) {
        for (const pay of sale.payments ?? []) {
          const key = pay.method || "cash";
          methodTotals.set(key, (methodTotals.get(key) ?? 0) + Number(pay.amount));
        }
      }
      const realPaymentMix = [...methodTotals.entries()].map(([method, value]) => ({
        label: method.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        value,
        color: paymentMixColor(method),
      }));
      paymentMix =
        realPaymentMix.length > 0
          ? realPaymentMix
          : PLACEHOLDER_PAYMENT_MIX.map((p) => ({ ...p }));
      paymentMixIsPlaceholder = realPaymentMix.length === 0;
    }

    const branchSalesTrend7d: ChartPoint[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(startOfToday);
      day.setDate(day.getDate() - i);
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      const total = posted
        .filter((s) => {
          const d = new Date(s.soldAt);
          return d >= day && d < next;
        })
        .reduce((sum, s) => sum + Number(s.grandTotal), 0);
      branchSalesTrend7d.push({
        label: day.toLocaleDateString(undefined, { weekday: "short" }),
        value: total,
      });
    }

    const salesTrend7d: ChartPoint[] =
      salesPulse && salesPulse.salesTrend7d.length > 0
        ? salesPulse.salesTrend7d.map((p) => ({ label: p.label, value: p.value }))
        : branchSalesTrend7d;

    // Owner (and any analytics-wide role using pulse) KPIs
    const ownerTodaySalesTotal = salesPulse?.todaySales ?? todayTotal;
    const ownerYesterdaySalesTotal = salesPulse?.yesterdaySales ?? yesterdayTotal;
    const ownerSalesTrendPct =
      salesPulse?.vsYesterdayPct != null
        ? salesPulse.vsYesterdayPct
        : pctChange(ownerTodaySalesTotal, ownerYesterdaySalesTotal);
    const ownerSalesTrendLabel = formatPct(ownerSalesTrendPct);
    const ownerSalesTrendPositive = (ownerSalesTrendPct ?? 0) >= 0;
    const ownerTodayTxnCount = salesPulse?.todayTxnCount ?? todaySales.length;
    // Branch reporting count always reflects the tenant's full branch list —
    // branch-performance isn't scoped by the owner all/this-branch toggle.
    const branchesReportingToday = branchPerformance.filter((b) => b.todayTxnCount > 0).length;
    const branchesReportingTotal = branchPerformance.length;

    const ownerScopeLabel =
      isOwner && ownerScope === "this_branch" ? "This branch" : "All branches";
    const analyticsScope: "tenant" | "branch" =
      isOwner && ownerScope === "all_branches" ? "tenant" : "branch";

    const assignedBranchTargets = branchPerformance.filter(
      (b) => b.manager?.id && user?.id && b.manager.id === user.id,
    );
    const currentBranchPerf =
      branchPerformance.find((b) => b.branchId === branchId) ?? null;

    // Team snapshot / top branches: full ranking in all-branch mode; single row when scoped.
    const scopedBranchPerformance =
      isOwner && ownerScope === "this_branch" && branchId
        ? branchPerformance.filter((b) => b.branchId === branchId)
        : branchPerformance;

    const topBranchesByMonth = [...scopedBranchPerformance]
      .sort((a, b) => b.monthSales - a.monthSales)
      .slice(0, 5);

    // Gross profit estimate from margin report (Owner uses scope=tenant margin)
    const monthMargin = marginByProduct.reduce((sum, r) => sum + Number(r.margin), 0);
    const monthRevenue = marginByProduct.reduce((sum, r) => sum + Number(r.revenue), 0);
    const hasMarginData = monthRevenue > 0;
    const marginPct = hasMarginData ? (monthMargin / monthRevenue) * 100 : null;
    const marginRate = hasMarginData ? monthMargin / monthRevenue : 0.3;
    // Fallback rate kept for roles that still render an est. companion series; prefer hasMarginData for honesty.
    const todayGrossProfit = todayTotal * marginRate;
    const ownerTodayGrossProfit = ownerTodaySalesTotal * marginRate;
    // Same prior-period definition as sales pulse (vs yesterday); rate cancels so % tracks sales when rate is fixed.
    const ownerYesterdayGrossProfit = ownerYesterdaySalesTotal * marginRate;
    const ownerGrossProfitTrendPct = hasMarginData
      ? salesPulse?.vsYesterdayPct != null
        ? salesPulse.vsYesterdayPct
        : pctChange(ownerTodayGrossProfit, ownerYesterdayGrossProfit)
      : null;
    const ownerGrossProfitTrendLabel = formatPct(ownerGrossProfitTrendPct);
    const ownerGrossProfitTrendPositive = (ownerGrossProfitTrendPct ?? 0) >= 0;

    // Prefer ops-snapshot for Owner/Manager analytics KPIs (scoped server-side).

    // Top products today
    const productQty = new Map<string, { name: string; sku: string; qty: number }>();
    for (const sale of todaySales) {
      for (const item of sale.items) {
        const key = item.product.sku;
        const cur = productQty.get(key) ?? { name: item.product.name, sku: key, qty: 0 };
        cur.qty += item.qty;
        productQty.set(key, cur);
      }
    }
    const topProductsToday = [...productQty.values()]
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 8);
    const fastMoversCount = topProductsToday.length;

    // Staff productivity from sellers
    const sellerMap = new Map<
      string,
      { id: string; name: string; sales: number; transactions: number }
    >();
    for (const sale of todaySales) {
      const id = sale.seller?.id ?? "unknown";
      const name = sale.seller?.fullName ?? "Unassigned";
      const cur = sellerMap.get(id) ?? { id, name, sales: 0, transactions: 0 };
      cur.sales += Number(sale.grandTotal);
      cur.transactions += 1;
      sellerMap.set(id, cur);
    }
    const staffProductivity = [...sellerMap.values()]
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 6);

    // Revenue vs purchases by week (purchases approximated from open PO item costs received this month — placeholder-ish)
    const revenueVsPurchases: SeriesPoint[] = [];
    for (let w = 3; w >= 0; w--) {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - w * 7 - 6);
      const end = new Date(startOfToday);
      end.setDate(end.getDate() - w * 7 + 1);
      const rev = posted
        .filter((s) => {
          const d = new Date(s.soldAt);
          return d >= start && d < end;
        })
        .reduce((sum, s) => sum + Number(s.grandTotal), 0);
      // Approximate purchases from PO createdAt in window
      const purch = purchaseOrders
        .filter((po) => {
          const d = new Date(po.createdAt);
          return d >= start && d < end && po.status !== "cancelled";
        })
        .reduce(
          (sum, po) =>
            sum +
            po.items.reduce((ls, it) => ls + Number(it.unitCost) * it.orderedQty, 0),
          0,
        );
      revenueVsPurchases.push({
        label: `W${4 - w}`,
        a: rev,
        b: purch,
      });
    }

    const openTransfers = transfers.filter((t) =>
      ["requested", "approved", "in_transit", "in_progress"].includes(t.status),
    );
    // Real approval queues — PO pending_approval, transfer requested, return pending_approval.
    const pendingPoApprovals = pendingApproval.length;
    const pendingTransferApprovals = transfers.filter((t) => t.status === "requested").length;
    const pendingReturnApprovals = goodsReturns.filter((r) => r.status === "pending_approval").length;
    const pendingApprovalsTotal =
      pendingPoApprovals + pendingTransferApprovals + pendingReturnApprovals;
    const stocktakesInProgress = stocktakes.filter((s) =>
      ["draft", "scheduled", "counting", "submitted", "under_review"].includes(s.status),
    );

    const pharmacistHolds = holds.filter((h) => h.needsPharmacist);
    const controlledNearExpiry = nearExpiryItems.slice(0, 8);
    const controlledNearExpiryProducts = nearExpiryItems.filter((b) => b.product.isControlled);
    const controlledAttentionIds = new Set<string>([
      ...controlledAttentionRows.map((r) => r.productId),
      ...controlledNearExpiryProducts.map((b) => b.productId),
    ]);
    const controlledAttentionCount = controlledAttentionIds.size;
    const controlledLowStockCount = controlledAttentionRows.length;
    const controlledNearExpiryCount = controlledNearExpiryProducts.length;

    const currentBranch = branches.find((b) => b.id === branchId);

    // Dispensed today ≈ items sold today
    const dispensedToday = todaySales.reduce(
      (sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0),
      0,
    );
    const dispensedYesterday = yesterdaySales.reduce(
      (sum, s) => sum + s.items.reduce((q, i) => q + i.qty, 0),
      0,
    );
    const dispensedTrendPct = pctChange(dispensedToday, dispensedYesterday);
    const dispensedTrendLabel = formatPct(dispensedTrendPct);
    const dispensedTrendPositive = (dispensedTrendPct ?? 0) >= 0;

    // Owner "all branches" KPIs come from opsSnapshot (tenant-scoped). Until it
    // loads, the branch-scoped fallback below is the *wrong scope* (this
    // branch, not the tenant) — not just less precise — so callers should
    // treat these as pending (show a loading state) rather than display them.
    const ownerKpisPending = isOwner && ownerScope === "all_branches" && !opsSnapshot;

    const openPosCount =
      isOwner && opsSnapshot ? opsSnapshot.openPoCount : openPos.length;
    const openPoValueResolved =
      isOwner && opsSnapshot ? opsSnapshot.openPoValue : openPoValue;
    const nearExpiryCountResolved =
      isOwner && opsSnapshot
        ? opsSnapshot.nearExpiry
        : nearExpiryItems.length || inventory?.nearExpiry || 0;
    const controlledAttentionResolved =
      isOwner && opsSnapshot
        ? opsSnapshot.controlledAttentionCount
        : controlledAttentionCount;
    const pendingApprovalResolved =
      isOwner && opsSnapshot ? opsSnapshot.pendingApproval : pendingPoApprovals;
    const overduePosResolved =
      isOwner && opsSnapshot ? opsSnapshot.overduePos : overduePos.length;
    const ownerLowStock =
      isOwner && opsSnapshot ? opsSnapshot.lowStock : (inventory?.lowStock ?? null);
    const ownerStockValue =
      isOwner && opsSnapshot ? opsSnapshot.stockValue : (inventory?.stockValue ?? null);

    return {
      todaySalesCount: todaySales.length,
      todaySalesTotal: todayTotal,
      yesterdaySalesTotal: yesterdayTotal,
      salesTrendPct,
      salesTrendLabel: formatPct(salesTrendPct),
      salesTrendPositive: (salesTrendPct ?? 0) >= 0,
      monthSalesCount: salesSummary?.count ?? monthSales.length,
      monthSalesTotal: salesSummary ? Number(salesSummary.grandTotal) : monthTotalFromList,
      recentSales: posted.slice(0, 8),
      todaySales,
      openPos: openPosCount,
      openPoValue: openPoValueResolved,
      overduePos: overduePosResolved,
      /** POs only — kept for Owner / alerts that label specifically as POs. */
      pendingApproval: pendingApprovalResolved,
      pendingPoApprovals,
      pendingTransferApprovals,
      pendingReturnApprovals,
      /** Manager KPI: sum of real PO + transfer + return approval queues. */
      pendingApprovalsTotal,
      openPoList: openPos.slice(0, 6),
      pendingApprovalList: pendingApproval.slice(0, 6),
      reorderCount: reorder?.items.length ?? 0,
      topReorder: reorder?.items.slice(0, 5) ?? [],
      salesTrend7d,
      hourlyToday,
      hourlyUnitsToday,
      paymentMix,
      paymentMixIsPlaceholder,
      paymentMixLabel,
      todayGrossProfit,
      ownerTodayGrossProfit,
      ownerTodaySalesTotal,
      ownerTodayTxnCount,
      ownerSalesTrendLabel,
      ownerSalesTrendPositive,
      ownerGrossProfitTrendLabel,
      ownerGrossProfitTrendPositive,
      branchesReportingToday,
      branchesReportingTotal,
      ownerLowStock,
      ownerStockValue,
      ownerKpisPending,
      ownerScopeLabel,
      analyticsScope,
      analyticsBranchId,
      hasMarginData,
      marginPct,
      topProductsToday,
      // Tenant-wide fast-movers need a dedicated rollup; shell sales list is branch-only.
      fastMoversCount:
        isOwner && ownerScope === "all_branches" ? null : fastMoversCount,
      deadStockCount,
      staffProductivity,
      revenueVsPurchases,
      /** Full list for target setting; table UI should prefer scopedBranchPerformance. */
      branchPerformance,
      scopedBranchPerformance,
      branchPerfYearMonth,
      topBranchesByMonth,
      assignedBranchTargets,
      currentBranchPerf,
      financial,
      salesPulse,
      opsSnapshot,
      inventoryImprovement,
      inventoryImprovedCount: inventoryImprovement?.improvedCount ?? null,
      inventoryImprovedDays: inventoryImprovement?.days ?? 7,
      holds,
      holdCount: holds.length,
      holdValue: holds.reduce((s, h) => s + Number(h.total), 0),
      pharmacistHolds,
      openTransfers: openTransfers.length,
      transferList: transfers.slice(0, 6),
      stocktakesInProgress: stocktakesInProgress.length,
      stocktakeList: stocktakes.slice(0, 5),
      prescriptions: prescriptions.slice(0, 8),
      prescriptionCount: prescriptions.length,
      nearExpiryItems: controlledNearExpiry,
      nearExpiryCount: nearExpiryCountResolved,
      controlledAttentionCount: controlledAttentionResolved,
      controlledLowStockCount,
      controlledNearExpiryCount,
      controlledAttentionRows: controlledAttentionRows.slice(0, 6),
      movements: movements.slice(0, 10),
      lowStockRows,
      returnsTodayCount,
      returnsTodayTotal,
      dispensedToday,
      dispensedTrendLabel,
      dispensedTrendPositive,
      branches,
      branchLabel: currentBranch
        ? `${currentBranch.city ? `${currentBranch.city} — ` : ""}${currentBranch.name}`
        : null,
      branchCount: branches.length,
      catalogSkuCount: inventory?.skuCount ?? null,
    };
  }, [
    analyticsBranchId,
    branchId,
    branches,
    branchPerformance,
    deadStockCount,
    financial,
    holds,
    inventory,
    isOwner,
    canViewAnalyticsWide,
    marginByProduct,
    movements,
    nearExpiryItems,
    opsSnapshot,
    inventoryImprovement,
    ownerScope,
    prescriptions,
    purchaseOrders,
    reorder,
    sales,
    salesPulse,
    salesSummary,
    stocktakes,
    transfers,
    goodsReturns,
    lowStockRows,
    controlledAttentionRows,
    user?.id,
  ]);

  const greeting = user?.fullName?.split(" ")[0] ?? "there";

  return {
    branchId,
    loading,
    error,
    lastUpdatedAt,
    reload,
    inventory,
    greeting,
    userRoles,
    canViewPurchasing,
    canViewReports,
    ownerScope,
    setOwnerScope,
    ...derived,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
