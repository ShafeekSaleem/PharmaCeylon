"use client";

import { useMemo } from "react";
import { AiInsightsCard } from "../components/ai-insights-card";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { MANAGER_AI_INSIGHTS, type AiInsight } from "../lib/placeholder-data";

export function ManagerAiInsightsWidget({ data }: { data: DashboardData }) {
  const { inventory, nearExpiryCount, overduePos } = data;

  const liveInsights = useMemo(() => {
    const live: AiInsight[] = [];
    if ((inventory?.lowStock ?? 0) > 0) {
      live.push({
        id: "live-reorder",
        title: "Reorder recommendation",
        detail: `${inventory!.lowStock} low-stock SKUs need replenishment at this branch.`,
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
        href: "/inventory/batches",
      });
    }
    if (overduePos > 0) {
      live.push({
        id: "live-supply",
        title: "Supply delay",
        detail: `${overduePos} purchase order${overduePos === 1 ? "" : "s"} past expected delivery.`,
        tone: "danger",
        href: "/purchasing?status=overdue",
      });
    }
    return live;
  }, [inventory, nearExpiryCount, overduePos]);

  const allInsights = useMemo(() => {
    const filler = MANAGER_AI_INSIGHTS.filter((s) => !liveInsights.some((l) => l.title === s.title));
    return [...liveInsights, ...filler].slice(0, 4);
  }, [liveInsights]);

  return <AiInsightsCard insights={allInsights} footerHref="/reports" />;
}
