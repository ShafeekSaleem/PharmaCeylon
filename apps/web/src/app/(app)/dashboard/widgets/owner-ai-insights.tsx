"use client";

import { useMemo } from "react";
import { AiInsightsCard } from "../components/ai-insights-card";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { OWNER_AI_INSIGHTS, type AiInsight } from "../lib/placeholder-data";

export function OwnerAiInsightsWidget({ data }: { data: DashboardData }) {
  const { ownerLowStock, nearExpiryCount, deadStockCount, overduePos, pendingApproval, ownerScopeLabel } = data;
  const scopePhrase = ownerScopeLabel.toLowerCase();

  const liveInsights = useMemo(() => {
    const live: AiInsight[] = [];
    if ((ownerLowStock ?? 0) > 0) {
      live.push({
        id: "live-reorder",
        title: "Reorder recommendation",
        detail: `${ownerLowStock} low-stock SKUs need replenishment (${scopePhrase}).`,
        tone: "warning",
        href: "/inventory?view=low",
      });
    }
    if (nearExpiryCount > 0) {
      live.push({
        id: "live-expiry",
        title: "Near-expiry risk",
        detail: `${nearExpiryCount} batches expire within 30 days — prioritize FEFO rotation.`,
        tone: "warning",
        href: "/inventory/batches?nearExpiryDays=30",
      });
    }
    if (deadStockCount != null && deadStockCount > 0) {
      live.push({
        id: "live-dead",
        title: "Dead stock candidates",
        detail: `${deadStockCount} slow movers with no sales in 90 days.`,
        tone: "info",
        href: "/reports?tab=dead",
      });
    }
    if (overduePos > 0) {
      live.push({
        id: "live-supply",
        title: "Supply delay",
        detail: `${overduePos} purchase orders are past expected delivery.`,
        tone: "danger",
        href: "/purchasing?status=overdue",
      });
    }
    if (pendingApproval > 0) {
      live.push({
        id: "live-po",
        title: "Approval bottleneck",
        detail: `${pendingApproval} POs awaiting approval may delay replenishment.`,
        tone: "info",
        href: "/purchasing?status=pending_approval",
      });
    }
    return live.slice(0, 5);
  }, [deadStockCount, nearExpiryCount, overduePos, ownerLowStock, pendingApproval, scopePhrase]);

  const allInsights = useMemo(() => {
    const filler = OWNER_AI_INSIGHTS.filter((s) => !liveInsights.some((l) => l.title === s.title));
    return [...liveInsights, ...filler].slice(0, 5);
  }, [liveInsights]);

  return <AiInsightsCard insights={allInsights} footerHref="/reports" compact />;
}
