"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  InventorySummary,
  MovementRow,
} from "@/app/(app)/inventory/types";
import type { PurchaseOrderListItem } from "@/app/(app)/purchasing/types";
import { isPoOverdue } from "@/app/(app)/purchasing/utils";
import {
  apiJson,
  fetchTenantBranches,
  type TenantBranch,
} from "@/lib/auth-client";
import { useAuth } from "@/lib/use-auth";
import { useRoleAccess } from "@/lib/use-role-access";
import type { ChartPoint } from "../components/simple-charts";
import type {
  DashboardSalesMetrics,
  DashboardStockMetrics,
} from "@pharmaceylon/shared";
import { usePermissions } from "@/lib/permissions";
import { paymentMixColor } from "../lib/payment-mix-colors";

export type SaleRow = {
  id: string;
  invoiceNo: string;
  soldAt: string;
  grandTotal: string;
  status?: string;
  customer?: { id: string; fullName: string; phone: string | null } | null;
  payments?: Array<{ method: string; amount: string }>;
  items: Array<{
    qty: number;
    product: { id: string; name: string; sku: string };
  }>;
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

function withAnalyticsBranch(
  path: string,
  branchId: string | null | undefined,
): string {
  if (!branchId) return path;
  const qs = `branchId=${encodeURIComponent(branchId)}`;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

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
  scope?: string;
  title?: string | null;
  areaLabel?: string | null;
  lineCount?: number;
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
  const { userRoles } = useRoleAccess();

  const { permissionKeys, loading: permissionsLoading } = usePermissions();
  const has = (key: string) => permissionKeys.includes(key);
  const canViewSales = has("sales.view");
  const personalSales = userRoles.length > 0 && userRoles.every((role) => role === "cashier");
  const canViewInventory = has("inventory.view");
  const canViewPurchasing = has("purchasing.view");
  const canViewReports = has("reports.view");
  const canViewInsights = has("analytics.view");
  const canViewPos = has("sales.pos_use");
  const canViewOps = has("transfers.view");
  const canViewReturns = has("returns.view");
  const canViewStocktakes = has("stocktakes.use");

  const [stockMetrics, setStockMetrics] =
    useState<DashboardStockMetrics | null>(null);
  const [salesMetrics, setSalesMetrics] =
    useState<DashboardSalesMetrics | null>(null);
  const requestRef = useRef<{ id: number; controller: AbortController | null }>(
    { id: 0, controller: null },
  );
  const refreshedAt = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [inventory, setInventory] = useState<InventorySummary | null>(null);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderListItem[]>(
    [],
  );
  const [reorder, setReorder] = useState<ReorderResponse | null>(null);
  const [holds, setHolds] = useState<HoldRow[]>([]);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [goodsReturns, setGoodsReturns] = useState<ReturnRow[]>([]);
  const [stocktakes, setStocktakes] = useState<StocktakeRow[]>([]);
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
      product: {
        sku: string;
        name: string;
        reorderLevel: number;
        isControlled: boolean;
      };
    }>
  >([]);
  const [controlledAttentionRows, setControlledAttentionRows] = useState<
    Array<{
      productId: string;
      qtyOnHand: number;
      product: {
        sku: string;
        name: string;
        reorderLevel: number;
        isControlled: boolean;
      };
    }>
  >([]);
  const [branches, setBranches] = useState<TenantBranch[]>([]);
  const [branchPerformance, setBranchPerformance] = useState<
    BranchPerformanceRow[]
  >([]);
  const [branchPerfYearMonth, setBranchPerfYearMonth] = useState<string | null>(
    null,
  );
  const [financial, setFinancial] = useState<FinancialSnapshot | null>(null);
  const [salesPulse, setSalesPulse] = useState<SalesPulse | null>(null);
  const [opsSnapshot, setOpsSnapshot] = useState<OpsSnapshot | null>(null);
  const [inventoryImprovement, setInventoryImprovement] =
    useState<InventoryImprovement | null>(null);
  const [deadStockCount, setDeadStockCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  /** Higher-value sections whose fetch failed this reload — these panels fall back to an empty
   *  value on error (so one bad endpoint doesn't blank the whole dashboard), but that fallback
   *  is visually identical to "genuinely nothing here" unless something surfaces the failure.
   *  Reset at the start of every `reload()`. */
  const [failedSections, setFailedSections] = useState<Set<string>>(new Set());
  const markSectionFailed = useCallback((label: string) => {
    setFailedSections((prev) => {
      if (prev.has(label)) return prev;
      const next = new Set(prev);
      next.add(label);
      return next;
    });
  }, []);

  const canViewAnalyticsWide = has("analytics.view");
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
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const id = ++requestRef.current.id;
    requestRef.current.controller = controller;
    const current = () =>
      requestRef.current.id === id && !controller.signal.aborted;
    const safe =
      <T>(setter: (value: T) => void) =>
      (value: T) => {
        if (current()) setter(value);
      };
    const request = <T>(path: string) =>
      apiJson<T>(path, {
        signal: controller.signal,
        headers: { "x-branch-id": branchId ?? "" },
      });
    const fail = (name: string) => {
      if (current()) markSectionFailed(name);
    };
    if (permissionsLoading) return;
    if (!branchId) {
      safe(setInventory)(null);
      safe(setSalesMetrics)(null);
      safe(setStockMetrics)(null);
      safe(setSales)([]);
      safe(setPurchaseOrders)([]);
      safe(setReorder)(null);
      safe(setHolds)([]);
      safe(setTransfers)([]);
      safe(setGoodsReturns)([]);
      safe(setStocktakes)([]);
      safe(setNearExpiryItems)([]);
      safe(setMarginByProduct)([]);
      safe(setMovements)([]);
      safe(setLowStockRows)([]);
      safe(setControlledAttentionRows)([]);
      safe(setBranches)([]);
      safe(setBranchPerformance)([]);
      safe(setBranchPerfYearMonth)(null);
      safe(setFinancial)(null);
      safe(setSalesPulse)(null);
      safe(setOpsSnapshot)(null);
      safe(setInventoryImprovement)(null);
      safe(setDeadStockCount)(null);
      safe(setLoading)(false);
      safe(setError)(null);
      safe(setFailedSections)(new Set());
      return;
    }

    safe(setLoading)(refreshedAt.current === 0);
    safe(setRefreshing)(true);
    window.dispatchEvent(new Event("dashboard:refresh"));
    safe(setError)(null);
    safe(setFailedSections)(new Set());

    try {
      if (!canViewSales) {
        safe(setSales)([]);
        safe(setSalesMetrics)(null);
      }
      if (!canViewInventory) {
        safe(setInventory)(null);
        safe(setStockMetrics)(null);
        safe(setNearExpiryItems)([]);
        safe(setLowStockRows)([]);
        safe(setControlledAttentionRows)([]);
      }
      const tasks: Promise<void>[] = [
        ...(canViewInventory
          ? [
              request<DashboardStockMetrics>("/dashboard/stock-metrics")
                .then(safe(setStockMetrics))
                .catch(() => {
                  safe(setStockMetrics)(null);
                  fail("Stock metrics");
                }),
              request<InventorySummary>("/inventory/summary?period=this_month")
                .then(safe(setInventory))
                .catch(() => {
                  safe(setInventory)(null);
                  fail("Inventory summary");
                }),
            ]
          : []),
        ...(canViewSales
          ? [
              request<SaleRow[]>(personalSales ? "/sales?mine=1" : "/sales")
                .then(safe(setSales))
                .catch(() => {
                  safe(setSales)([]);
                  fail("Recent sales");
                }),
              request<DashboardSalesMetrics>("/dashboard/sales-metrics")
                .then(safe(setSalesMetrics))
                .catch(() => {
                  safe(setSalesMetrics)(null);
                  fail("Sales metrics");
                }),
            ]
          : []),
        fetchTenantBranches()
          .then(safe(setBranches))
          .catch(() => safe(setBranches)([])),
      ];

      // Near-expiry batches — inventory endpoint is available to more roles than /reports.
      if (canViewInventory)
        tasks.push(
          request<
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
              safe(setNearExpiryItems)(
                rows
                  .filter((b) => b.nearExpiry || b.expired)
                  .filter((b) => b.qtyOnHand > 0)
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
            .catch(() => {
              safe(setNearExpiryItems)([]);
              fail("Expiry batches");
            }),
        );

      if (canViewReports) {
        const reportScopeQs =
          isOwner && ownerScope === "all_branches" ? "&scope=tenant" : "";
        tasks.push(
          request<MarginRow[]>(
            `/reports/margin-by-product?days=30${reportScopeQs}`,
          )
            .then(safe(setMarginByProduct))
            .catch(() => {
              safe(setMarginByProduct)([]);
              fail("Product margins");
            }),
        );
      } else {
        safe(setMarginByProduct)([]);
      }

      if (canViewPurchasing) {
        tasks.push(
          request<PurchaseOrderListItem[]>("/purchasing/purchase-orders")
            .then(safe(setPurchaseOrders))
            .catch(() => {
              safe(setPurchaseOrders)([]);
              fail("Purchase orders");
            }),
        );
      } else {
        safe(setPurchaseOrders)([]);
      }

      if (canViewInsights) {
        tasks.push(
          request<ReorderResponse>("/analytics/reorder-recommendations")
            .then(safe(setReorder))
            .catch(() => {
              safe(setReorder)(null);
              fail("Reorder recommendations");
            }),
        );
      } else {
        safe(setReorder)(null);
      }

      if (canViewPos) {
        tasks.push(
          request<HoldRow[]>("/sales/holds")
            .then(safe(setHolds))
            .catch(() => {
              safe(setHolds)([]);
              fail("Held bills");
            }),
        );
      } else {
        safe(setHolds)([]);
      }

      // Stock-by-product is readable by cashier+; useful for counter / inventory dashboards.
      // Query low and out separately (server-side `status` filter) rather than
      // fetching an unfiltered page and filtering client-side — the unfiltered
      // query sorts by product name, so a `take` cap could silently drop every
      // real low/out row if none fell within the first N products alphabetically.
      type StockByProductRow = {
        productId: string;
        qtyOnHand: number;
        stockStatus: string;
        product: {
          sku: string;
          name: string;
          reorderLevel: number;
          isControlled: boolean;
        };
      };
      const mapStockRow = (
        r: StockByProductRow,
        forceControlled?: boolean,
      ) => ({
        productId: r.productId,
        qtyOnHand: r.qtyOnHand,
        product: {
          sku: r.product.sku,
          name: r.product.name,
          reorderLevel: r.product.reorderLevel,
          isControlled: forceControlled ?? Boolean(r.product.isControlled),
        },
      });
      if (canViewInventory)
        tasks.push(
          Promise.all([
            request<{ items: StockByProductRow[] }>(
              "/inventory/stock-by-product?ledgerOnly=1&status=out&take=20",
            ),
            request<{ items: StockByProductRow[] }>(
              "/inventory/stock-by-product?ledgerOnly=1&status=low&take=20",
            ),
          ])
            .then(([outRes, lowRes]) =>
              safe(setLowStockRows)(
                [...(outRes.items ?? []), ...(lowRes.items ?? [])]
                  .slice(0, 8)
                  .map((r) => mapStockRow(r)),
              ),
            )
            .catch(() => {
              safe(setLowStockRows)([]);
              fail("Low-stock preview");
            }),
          Promise.all([
            request<{ items: StockByProductRow[] }>(
              "/inventory/stock-by-product?controlled=controlled&ledgerOnly=1&status=out&take=20",
            ),
            request<{ items: StockByProductRow[] }>(
              "/inventory/stock-by-product?controlled=controlled&ledgerOnly=1&status=low&take=20",
            ),
          ])
            .then(([outRes, lowRes]) =>
              safe(setControlledAttentionRows)(
                [...(outRes.items ?? []), ...(lowRes.items ?? [])]
                  .slice(0, 12)
                  .map((r) => mapStockRow(r, true)),
              ),
            )
            .catch(() => {
              safe(setControlledAttentionRows)([]);
              fail("Controlled-stock preview");
            }),
        );

      if (canViewOps) {
        tasks.push(
          request<TransferRow[]>("/transfers")
            .then(safe(setTransfers))
            .catch(() => {
              safe(setTransfers)([]);
              fail("Transfers");
            }),
          request<{ items: MovementRow[] }>("/inventory/movements?take=12")
            .then((r) => safe(setMovements)(r.items ?? []))
            .catch(() => {
              safe(setMovements)([]);
              fail("Stock movements");
            }),
        );
      } else {
        safe(setTransfers)([]);
        safe(setMovements)([]);
      }

      if (canViewReturns) {
        tasks.push(
          request<ReturnRow[]>("/returns")
            .then(safe(setGoodsReturns))
            .catch(() => {
              safe(setGoodsReturns)([]);
              fail("Supplier returns");
            }),
        );
      } else {
        safe(setGoodsReturns)([]);
      }

      if (canViewStocktakes) {
        tasks.push(
          request<StocktakeRow[]>("/stocktakes")
            .then(safe(setStocktakes))
            .catch(() => {
              safe(setStocktakes)([]);
              fail("Stocktakes");
            }),
        );
      } else {
        safe(setStocktakes)([]);
      }

      if (canViewAnalyticsWide) {
        // Owner: omit branchId for all_branches; pass shell branch for this_branch.
        // Manager: always active branch.
        const scoped = (path: string) =>
          withAnalyticsBranch(path, analyticsBranchId);

        tasks.push(
          request<{
            yearMonth: string;
            branches: BranchPerformanceRow[];
          }>("/analytics/branch-performance")
            .then((res) => {
              safe(setBranchPerfYearMonth)(res.yearMonth);
              safe(setBranchPerformance)(res.branches ?? []);
            })
            .catch(() => {
              safe(setBranchPerformance)([]);
              safe(setBranchPerfYearMonth)(null);
              fail("Branch Performance");
            }),
          request<FinancialSnapshot>(scoped("/analytics/financial-snapshot"))
            .then(safe(setFinancial))
            .catch(() => {
              safe(setFinancial)(null);
              fail("Financial Snapshot");
            }),
          request<SalesPulse>(scoped("/analytics/sales-pulse"))
            .then(safe(setSalesPulse))
            .catch(() => {
              safe(setSalesPulse)(null);
              fail("Sales overview");
            }),
          request<OpsSnapshot>(scoped("/analytics/ops-snapshot"))
            .then(safe(setOpsSnapshot))
            .catch(() => {
              safe(setOpsSnapshot)(null);
              fail("Ops Snapshot");
            }),
          request<InventoryImprovement>(
            scoped("/analytics/inventory-improvement?days=7"),
          )
            .then(safe(setInventoryImprovement))
            .catch(() => {
              safe(setInventoryImprovement)(null);
              fail("Inventory improvement");
            }),
        );
      } else {
        safe(setBranchPerformance)([]);
        safe(setBranchPerfYearMonth)(null);
        safe(setFinancial)(null);
        safe(setSalesPulse)(null);
        safe(setOpsSnapshot)(null);
        safe(setInventoryImprovement)(null);
      }

      if (canViewReports) {
        const deadScopeQs =
          isOwner && ownerScope === "all_branches" ? "&scope=tenant" : "";
        tasks.push(
          request<{ items: unknown[] }>(
            `/reports/dead-stock?days=90${deadScopeQs}`,
          )
            .then((r) => safe(setDeadStockCount)(r.items?.length ?? 0))
            .catch(() => safe(setDeadStockCount)(null)),
        );
      } else {
        safe(setDeadStockCount)(null);
      }

      await Promise.all(
        tasks.map((task) => task.catch(() => fail("Dashboard section"))),
      );
      if (!current()) return;
      refreshedAt.current = Date.now();
      safe(setLastUpdatedAt)(new Date().toISOString());
    } catch (err) {
      safe(setError)(
        err instanceof Error ? err.message : "Failed to load dashboard",
      );
    } finally {
      safe(setLoading)(false);
      safe(setRefreshing)(false);
    }
  }, [
    analyticsBranchId,
    branchId,
    permissionsLoading,
    canViewSales,
    personalSales,
    canViewInventory,
    canViewAnalyticsWide,
    canViewInsights,
    canViewOps,
    canViewPos,
    canViewPurchasing,
    canViewReports,
    canViewReturns,
    canViewStocktakes,
    isOwner,
    markSectionFailed,
    ownerScope,
  ]);

  useEffect(() => {
    refreshedAt.current = 0;
    void reload();
    const refresh = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - refreshedAt.current > 5_000
      )
        void reload();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      requestRef.current.controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  const derived = useMemo(() => {
    const keyOf = (iso: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: salesMetrics?.timezone ?? "Asia/Colombo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(iso));
    const posted = sales.filter(
      (sale) =>
        sale.soldAt &&
        (salesMetrics?.scope !== "personal" || sale.seller?.id === user?.id),
    );
    const todaySales = posted.filter(
      (sale) => keyOf(sale.soldAt) === salesMetrics?.todayKey,
    );
    const todayTotal = salesMetrics?.today.total ?? 0;
    const yesterdayTotal = salesMetrics?.yesterday.total ?? 0;
    const salesTrendPct = pctChange(todayTotal, yesterdayTotal);

    const openPoStatuses = new Set([
      "draft",
      "pending_approval",
      "issued",
      "partially_received",
    ]);
    const openPos = purchaseOrders.filter((po) =>
      openPoStatuses.has(po.status),
    );
    const overduePos = purchaseOrders.filter(isPoOverdue);
    const pendingApproval = purchaseOrders.filter(
      (po) => po.status === "pending_approval",
    );
    const openPoValue = openPos.reduce(
      (sum, po) =>
        sum +
        po.items.reduce(
          (lineSum, item) => lineSum + Number(item.unitCost) * item.orderedQty,
          0,
        ),
      0,
    );

    const hourlyToday: ChartPoint[] = [];
    const hourlyUnitsToday: ChartPoint[] = [];
    const hourlyBillsToday: ChartPoint[] = [];
    const aggregateHourly = salesMetrics?.hourly ?? [];
    hourlyToday.splice(
      0,
      hourlyToday.length,
      ...aggregateHourly.map((h) => ({
        label: hourLabel(h.hour),
        value: h.total,
      })),
    );
    hourlyUnitsToday.splice(
      0,
      hourlyUnitsToday.length,
      ...aggregateHourly.map((h) => ({
        label: hourLabel(h.hour),
        value: h.units,
      })),
    );
    hourlyBillsToday.splice(
      0,
      hourlyBillsToday.length,
      ...aggregateHourly.map((h) => ({
        label: hourLabel(h.hour),
        value: h.count,
      })),
    );

    // Payment mix: prefer analytics pulse (tenant for Owner, branch for Manager)
    let paymentMix: Array<{ label: string; value: number; color: string }>;
    let paymentMixIsPlaceholder = false;
    let paymentMixLabel = "Today";

    if (
      salesPulse &&
      salesPulse.paymentMix.length > 0 &&
      canViewAnalyticsWide
    ) {
      paymentMix = salesPulse.paymentMix.map((p) => ({
        label: p.method
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
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
      for (const pay of salesMetrics?.payments ?? []) {
        {
          const key = pay.method || "cash";
          methodTotals.set(key, (methodTotals.get(key) ?? 0) + pay.value);
        }
      }
      const realPaymentMix = [...methodTotals.entries()].map(
        ([method, value]) => ({
          label: method
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          value,
          color: paymentMixColor(method),
        }),
      );
      paymentMix = realPaymentMix.length > 0 ? realPaymentMix : [];
      paymentMixIsPlaceholder = false;
    }

    const salesTrend7d: ChartPoint[] =
      salesPulse && salesPulse.salesTrend7d.length > 0
        ? salesPulse.salesTrend7d.map((p) => ({
            label: p.label,
            value: p.value,
          }))
        : (salesMetrics?.trend ?? []);

    // Owner (and any analytics-wide role using pulse) KPIs
    const ownerTodaySalesTotal =
      salesPulse?.todaySales ??
      (isOwner && ownerScope === "all_branches" ? 0 : todayTotal);
    const ownerYesterdaySalesTotal =
      salesPulse?.yesterdaySales ?? yesterdayTotal;
    const ownerSalesTrendPct =
      salesPulse?.vsYesterdayPct != null
        ? salesPulse.vsYesterdayPct
        : pctChange(ownerTodaySalesTotal, ownerYesterdaySalesTotal);
    const ownerSalesTrendLabel = formatPct(ownerSalesTrendPct);
    const ownerSalesTrendPositive = (ownerSalesTrendPct ?? 0) >= 0;
    const ownerTodayTxnCount =
      salesPulse?.todayTxnCount ?? salesMetrics?.today.count ?? 0;
    // Branch reporting count always reflects the tenant's full branch list —
    // branch-performance isn't scoped by the owner all/this-branch toggle.
    const branchesReportingToday = branchPerformance.filter(
      (b) => b.todayTxnCount > 0,
    ).length;
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

    const monthMargin = marginByProduct.reduce(
      (sum, r) => sum + Number(r.margin),
      0,
    );
    const monthRevenue = marginByProduct.reduce(
      (sum, r) => sum + Number(r.revenue),
      0,
    );
    const hasMarginData = marginByProduct.length > 0;
    const marginPct =
      hasMarginData && monthRevenue !== 0
        ? (monthMargin / monthRevenue) * 100
        : null;
    const ownerGrossProfit30d = monthMargin;

    // Prefer ops-snapshot for Owner/Manager analytics KPIs (scoped server-side).

    const openTransfers = transfers.filter((t) =>
      ["requested", "approved", "in_transit", "in_progress"].includes(t.status),
    );
    // Real approval queues — PO pending_approval, transfer requested, return pending_approval.
    const pendingPoApprovals = pendingApproval.length;
    const pendingTransferApprovals = transfers.filter(
      (t) => t.status === "requested",
    ).length;
    const pendingReturnApprovals = goodsReturns.filter(
      (r) => r.status === "pending_approval",
    ).length;
    const pendingApprovalsTotal =
      pendingPoApprovals + pendingTransferApprovals + pendingReturnApprovals;
    const stocktakesInProgress = stocktakes.filter((s) =>
      ["draft", "scheduled", "counting", "submitted", "under_review"].includes(
        s.status,
      ),
    );
    // Finer-grained buckets for the inventory clerk's Stocktakes panel stat strip.
    const stocktakesActiveCount = stocktakes.filter((s) =>
      ["counting", "submitted", "under_review"].includes(s.status),
    ).length;
    const stocktakesScheduledCount = stocktakes.filter((s) =>
      ["draft", "scheduled"].includes(s.status),
    ).length;
    const stocktakesCompletedCount = stocktakes.filter((s) =>
      ["completed", "posted", "approved"].includes(s.status),
    ).length;

    const pharmacistHolds = holds.filter((h) => h.needsPharmacist);
    const controlledAttentionCount = stockMetrics?.controlledAttention ?? 0;
    const controlledLowStockCount = stockMetrics?.controlledLow ?? 0;
    const controlledNearExpiryCount = stockMetrics?.controlledNearExpiry ?? 0;

    const currentBranch = branches.find((b) => b.id === branchId);

    // Dispensed today ≈ items sold today
    const dispensedToday = salesMetrics?.today.units ?? 0;
    const dispensedYesterday = salesMetrics?.yesterday.units ?? 0;
    const dispensedTrendPct = pctChange(dispensedToday, dispensedYesterday);
    const dispensedTrendLabel = formatPct(dispensedTrendPct);
    const dispensedTrendPositive = (dispensedTrendPct ?? 0) >= 0;

    // Owner "all branches" KPIs come from opsSnapshot (tenant-scoped). Until it
    // loads, the branch-scoped fallback below is the *wrong scope* (this
    // branch, not the tenant) — not just less precise — so callers should
    // treat these as pending (show a loading state) rather than display them.
    const ownerKpisPending =
      isOwner && ownerScope === "all_branches" && !opsSnapshot;

    const openPosCount =
      isOwner && opsSnapshot ? opsSnapshot.openPoCount : openPos.length;
    const openPoValueResolved =
      isOwner && opsSnapshot ? opsSnapshot.openPoValue : openPoValue;
    const nearExpiryCountResolved =
      isOwner && opsSnapshot
        ? opsSnapshot.nearExpiry
        : (inventory?.nearExpiry ?? nearExpiryItems.length);
    const controlledAttentionResolved =
      isOwner && opsSnapshot
        ? opsSnapshot.controlledAttentionCount
        : controlledAttentionCount;
    const pendingApprovalResolved =
      isOwner && opsSnapshot ? opsSnapshot.pendingApproval : pendingPoApprovals;
    const overduePosResolved =
      isOwner && opsSnapshot ? opsSnapshot.overduePos : overduePos.length;
    const ownerLowStock =
      isOwner && opsSnapshot
        ? opsSnapshot.lowStock
        : (inventory?.lowStock ?? null);
    const ownerStockValue =
      isOwner && opsSnapshot
        ? opsSnapshot.stockValue
        : (inventory?.stockValue ?? null);

    return {
      todaySalesCount: salesMetrics?.today.count ?? 0,
      todaySalesTotal: todayTotal,
      yesterdaySalesTotal: yesterdayTotal,
      yesterdaySalesCount: salesMetrics?.yesterday.count ?? 0,
      salesTrendPct,
      salesTrendLabel: formatPct(salesTrendPct),
      salesTrendPositive: (salesTrendPct ?? 0) >= 0,
      billsTrendLabel: formatPct(
        pctChange(
          salesMetrics?.today.count ?? 0,
          salesMetrics?.yesterday.count ?? 0,
        ),
      ),
      billsTrendPositive:
        (pctChange(
          salesMetrics?.today.count ?? 0,
          salesMetrics?.yesterday.count ?? 0,
        ) ?? 0) >= 0,
      monthSalesCount: salesMetrics?.month.count ?? 0,
      monthSalesTotal: salesMetrics?.month.total ?? 0,
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
      /** Unsliced — for panels that paginate instead of truncating. */
      openPoListFull: openPos,
      pendingApprovalList: pendingApproval.slice(0, 6),
      pendingApprovalListFull: pendingApproval,
      /** Overdue POs, unsliced-ish (top 6) — used for AI-insight example chips. */
      overduePosListFull: overduePos.slice(0, 6),
      reorderCount: reorder?.items.length ?? 0,
      topReorder: reorder?.items.slice(0, 5) ?? [],
      /** Unsliced — for panels that paginate instead of truncating. */
      topReorderFull: reorder?.items ?? [],
      salesTrend7d,
      hourlyToday,
      hourlyUnitsToday,
      hourlyBillsToday,
      paymentMix,
      paymentMixIsPlaceholder,
      paymentMixLabel,
      ownerGrossProfit30d,
      ownerTodaySalesTotal,
      ownerTodayTxnCount,
      ownerSalesTrendLabel,
      ownerSalesTrendPositive,
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
      topProductsToday: salesMetrics?.products ?? [],
      // Tenant-wide fast-movers need a dedicated rollup; shell sales list is branch-only.
      fastMoversCount:
        isOwner && ownerScope === "all_branches"
          ? null
          : (salesMetrics?.products.length ?? null),
      deadStockCount,
      staffProductivity: salesMetrics?.staff ?? [],
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
      holdCount: salesMetrics?.holds.count ?? 0,
      holdValue: salesMetrics?.holds.value ?? 0,
      pharmacistHolds,
      openTransfers: openTransfers.length,
      transferList: transfers.slice(0, 6),
      stocktakesInProgress: stocktakesInProgress.length,
      stocktakesActiveCount,
      stocktakesScheduledCount,
      stocktakesCompletedCount,
      stocktakeList: stocktakes.slice(0, 5),
      nearExpiryItems,
      nearExpiryCount: nearExpiryCountResolved,
      controlledAttentionCount: controlledAttentionResolved,
      controlledLowStockCount,
      controlledNearExpiryCount,
      controlledAttentionRows: controlledAttentionRows.slice(0, 6),
      movements: movements.slice(0, 10),
      lowStockRows,
      lowStockCount: stockMetrics ? stockMetrics.low + stockMetrics.out : null,
      returnsTodayCount: salesMetrics?.refunds.count ?? 0,
      returnsTodayTotal: salesMetrics?.refunds.total ?? 0,
      dispensedToday,
      dispensedYesterday,
      dispensedTrendPct,
      dispensedTrendLabel,
      dispensedTrendPositive,
      branches,
      branchLabel: currentBranch
        ? `${currentBranch.city ? `${currentBranch.city} — ` : ""}${currentBranch.name}`
        : null,
      /* Just the name. The city belongs on the branch switcher, where you are choosing
         between branches; in a sentence about one branch it reads as part of its name. */
      branchName: currentBranch?.name ?? null,
      branchCount: branches.length,
      catalogSkuCount: inventory?.skuCount ?? null,
      /** Unsliced — for panels that paginate a combined PO/transfer/return list. */
      transfers,
      goodsReturns,
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
    purchaseOrders,
    reorder,
    sales,
    salesMetrics,
    stockMetrics,
    salesPulse,
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
    refreshing,
    salesMetrics,
    error,
    failedSections,
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
