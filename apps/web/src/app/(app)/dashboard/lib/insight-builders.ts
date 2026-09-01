/** Builds each role's full (unsliced) AI insight list — live-computed items derived from
 *  `useDashboardData()` merged with static filler, deduped by title. Shared by the small
 *  dashboard "AI Insights" widget preview (which slices to a handful) and the `/insights` hub
 *  page (which shows the full list) so the two never drift out of sync. */

import { formatExpiry } from "@/app/(app)/inventory/utils";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { CASHIER_AI_INSIGHTS, MANAGER_AI_INSIGHTS, OWNER_AI_INSIGHTS, type AiInsight } from "./placeholder-data";

function mergeWithFiller(live: AiInsight[], filler: AiInsight[]): AiInsight[] {
  return [...live, ...filler.filter((s) => !live.some((l) => l.title === s.title))];
}

export function buildOwnerInsights(data: DashboardData): AiInsight[] {
  const {
    ownerLowStock,
    nearExpiryCount,
    deadStockCount,
    overduePos,
    pendingApproval,
    ownerScopeLabel,
    lowStockRows,
    nearExpiryItems,
    overduePosListFull,
    pendingApprovalListFull,
  } = data;
  const scopePhrase = ownerScopeLabel.toLowerCase();

  const live: AiInsight[] = [];
  if ((ownerLowStock ?? 0) > 0) {
    live.push({
      id: "live-reorder",
      title: "Reorder recommendation",
      detail: `Low-stock SKUs need replenishment (${scopePhrase}).`,
      tone: "warning",
      category: "inventory",
      href: "/inventory?view=low",
      count: ownerLowStock ?? undefined,
      countLabel: "SKUs",
      examples: lowStockRows.slice(0, 3).map((r) => ({
        label: r.product.name,
        badge: `${r.qtyOnHand} left`,
        tone: "negative" as const,
      })),
    });
  }
  if (nearExpiryCount > 0) {
    live.push({
      id: "live-expiry",
      title: "Near-expiry risk",
      detail: "Batches expire within 30 days — prioritize FEFO rotation.",
      tone: "warning",
      category: "inventory",
      href: "/inventory/batches?nearExpiryDays=30",
      count: nearExpiryCount,
      countLabel: "batches",
      examples: nearExpiryItems.slice(0, 3).map((b) => ({
        label: b.product.name,
        badge: formatExpiry(b.expiryDate),
        tone: "negative" as const,
      })),
    });
  }
  if (deadStockCount != null && deadStockCount > 0) {
    live.push({
      id: "live-dead",
      title: "Dead stock candidates",
      detail: "Slow movers with no sales in 90 days.",
      tone: "info",
      category: "inventory",
      href: "/reports?category=inventory&report=stock-health",
      count: deadStockCount,
      countLabel: "SKUs",
    });
  }
  if (overduePos > 0) {
    live.push({
      id: "live-supply",
      title: "Supply delay",
      detail: "Purchase orders are past expected delivery.",
      tone: "danger",
      category: "purchasing",
      href: "/purchasing?status=overdue",
      count: overduePos,
      countLabel: "POs",
      examples: overduePosListFull.slice(0, 3).map((po) => ({
        label: po.poNumber,
        badge: po.supplier.name,
        tone: "neutral" as const,
      })),
    });
  }
  if (pendingApproval > 0) {
    live.push({
      id: "live-po",
      title: "Approval bottleneck",
      detail: "POs awaiting approval may delay replenishment.",
      tone: "info",
      category: "purchasing",
      href: "/purchasing?status=pending_approval",
      count: pendingApproval,
      countLabel: "POs",
      examples: pendingApprovalListFull.slice(0, 3).map((po) => ({
        label: po.poNumber,
        badge: po.supplier.name,
        tone: "neutral" as const,
      })),
    });
  }
  return mergeWithFiller(live, OWNER_AI_INSIGHTS);
}

export function buildManagerInsights(data: DashboardData): AiInsight[] {
  const { inventory, nearExpiryCount, overduePos, lowStockRows, nearExpiryItems, overduePosListFull } = data;

  const live: AiInsight[] = [];
  if ((inventory?.lowStock ?? 0) > 0) {
    live.push({
      id: "live-reorder",
      title: "Reorder recommendation",
      detail: "Low-stock SKUs need replenishment at this branch.",
      tone: "warning",
      category: "inventory",
      href: "/inventory?view=low",
      count: inventory!.lowStock,
      countLabel: "SKUs",
      examples: lowStockRows.slice(0, 3).map((r) => ({
        label: r.product.name,
        badge: `${r.qtyOnHand} left`,
        tone: "negative" as const,
      })),
    });
  }
  if (nearExpiryCount > 0) {
    live.push({
      id: "live-expiry",
      title: "Near-expiry risk",
      detail: "Batches expire within 30 days — prioritize FEFO rotation.",
      tone: "warning",
      category: "inventory",
      href: "/inventory/batches",
      count: nearExpiryCount,
      countLabel: "batches",
      examples: nearExpiryItems.slice(0, 3).map((b) => ({
        label: b.product.name,
        badge: formatExpiry(b.expiryDate),
        tone: "negative" as const,
      })),
    });
  }
  if (overduePos > 0) {
    live.push({
      id: "live-supply",
      title: "Supply delay",
      detail: `Purchase order${overduePos === 1 ? "" : "s"} past expected delivery.`,
      tone: "danger",
      category: "purchasing",
      href: "/purchasing?status=overdue",
      count: overduePos,
      countLabel: "POs",
      examples: overduePosListFull.slice(0, 3).map((po) => ({
        label: po.poNumber,
        badge: po.supplier.name,
        tone: "neutral" as const,
      })),
    });
  }
  return mergeWithFiller(live, MANAGER_AI_INSIGHTS);
}

export function buildCashierInsights(data: DashboardData): AiInsight[] {
  const { lowStockRows, pharmacistHolds } = data;
  const rxWaiting = pharmacistHolds.length;

  const live: AiInsight[] = [];
  if (lowStockRows.length > 0) {
    live.push({
      id: "live-lowstock",
      title: "Stock up fast mover",
      detail: "Counter SKUs running low — check before your next restock round.",
      tone: "warning",
      category: "inventory",
      href: "/inventory?view=low",
      actionLabel: "View low stock",
      count: lowStockRows.length,
      countLabel: "SKUs",
      examples: lowStockRows.slice(0, 3).map((r) => ({
        label: r.product.name,
        badge: `${r.qtyOnHand} left`,
        tone: "negative" as const,
      })),
    });
  }
  if (rxWaiting > 0) {
    live.push({
      id: "live-rx",
      title: "Verify prescription-required items",
      detail: "Held carts waiting on pharmacist verification before checkout.",
      tone: "danger",
      category: "operations",
      href: "/pos?panel=holds",
      actionLabel: "Open POS",
      count: rxWaiting,
      countLabel: rxWaiting === 1 ? "cart" : "carts",
    });
  }
  return mergeWithFiller(live, CASHIER_AI_INSIGHTS);
}
