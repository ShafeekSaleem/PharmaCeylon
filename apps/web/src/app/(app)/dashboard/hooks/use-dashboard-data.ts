"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { InventorySummary } from "@/app/(app)/inventory/types";
import type { PurchaseOrderListItem } from "@/app/(app)/purchasing/types";
import { isPoOverdue } from "@/app/(app)/purchasing/utils";
import { apiJson } from "@/lib/auth-client";
import { PURCHASING_ROLES, INSIGHTS_ROLES } from "@/lib/role-access";
import { useAuth } from "@/lib/use-auth";
import { useRoleAccess } from "@/lib/use-role-access";

type SaleRow = {
  id: string;
  invoiceNo: string;
  soldAt: string;
  grandTotal: string;
  items: Array<{ qty: number; product: { name: string; sku: string } }>;
};

type SalesSummary = {
  days: number;
  count: number;
  grandTotal: string;
};

type ReorderResponse = {
  items: Array<{ sku: string; name: string; onHand: number; suggestedQty: number }>;
};

export function useDashboardData() {
  const { branchId, user } = useAuth();
  const { canAccess } = useRoleAccess();
  const canViewPurchasing = canAccess(PURCHASING_ROLES);
  const canViewReports = canAccess(["owner", "manager", "analyst"]);

  const [inventory, setInventory] = useState<InventorySummary | null>(null);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [salesSummary, setSalesSummary] = useState<SalesSummary | null>(null);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderListItem[]>([]);
  const [reorder, setReorder] = useState<ReorderResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!branchId) {
      setInventory(null);
      setSales([]);
      setSalesSummary(null);
      setPurchaseOrders([]);
      setReorder(null);
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
      ];

      if (canViewReports) {
        tasks.push(
          apiJson<SalesSummary>("/reports/sales-summary?days=30").then(setSalesSummary),
        );
      } else {
        setSalesSummary(null);
      }

      if (canViewPurchasing) {
        tasks.push(
          apiJson<PurchaseOrderListItem[]>("/purchasing/purchase-orders").then(setPurchaseOrders),
        );
      } else {
        setPurchaseOrders([]);
      }

      if (canAccess(INSIGHTS_ROLES)) {
        tasks.push(
          apiJson<ReorderResponse>("/analytics/reorder-recommendations")
            .then(setReorder)
            .catch(() => setReorder(null)),
        );
      } else {
        setReorder(null);
      }

      await Promise.all(tasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, [branchId, canAccess, canViewPurchasing, canViewReports]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const derived = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const posted = sales.filter((s) => s.soldAt);
    const todaySales = posted.filter((s) => new Date(s.soldAt) >= startOfToday);
    const todayTotal = todaySales.reduce((sum, s) => sum + Number(s.grandTotal), 0);

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

    return {
      todaySalesCount: todaySales.length,
      todaySalesTotal: todayTotal,
      monthSalesCount: salesSummary?.count ?? monthSales.length,
      monthSalesTotal: salesSummary
        ? Number(salesSummary.grandTotal)
        : monthTotalFromList,
      recentSales: posted.slice(0, 8),
      openPos: openPos.length,
      overduePos: overduePos.length,
      pendingApproval: pendingApproval.length,
      reorderCount: reorder?.items.length ?? 0,
      topReorder: reorder?.items.slice(0, 5) ?? [],
    };
  }, [purchaseOrders, reorder, sales, salesSummary]);

  const greeting = user?.fullName?.split(" ")[0] ?? "there";

  return {
    branchId,
    loading,
    error,
    reload,
    inventory,
    greeting,
    canViewPurchasing,
    ...derived,
  };
}
