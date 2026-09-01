"use client";

import { useMemo } from "react";
import { AiInsightsCard } from "../components/ai-insights-card";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { CASHIER_AI_INSIGHTS, type AiInsight } from "../lib/placeholder-data";

export function CashierAiInsightsWidget({ data }: { data: DashboardData }) {
  const { lowStockRows, pharmacistHolds } = data;
  const rxWaiting = pharmacistHolds.length;

  const liveInsights = useMemo(() => {
    const live: AiInsight[] = [];
    if (lowStockRows.length > 0) {
      live.push({
        id: "live-lowstock",
        title: "Stock up fast mover",
        detail: `${lowStockRows.length} counter SKU${lowStockRows.length === 1 ? "" : "s"} running low — check before your next restock round.`,
        tone: "warning",
        href: "/inventory?view=low",
        actionLabel: "View low stock",
      });
    }
    if (rxWaiting > 0) {
      live.push({
        id: "live-rx",
        title: "Verify prescription-required items",
        detail: `${rxWaiting} held cart${rxWaiting === 1 ? "" : "s"} waiting on pharmacist verification before checkout.`,
        tone: "danger",
        href: "/pos?panel=holds",
        actionLabel: "Open POS",
      });
    }
    return live;
  }, [lowStockRows.length, rxWaiting]);

  const allInsights = useMemo(() => {
    const filler = CASHIER_AI_INSIGHTS.filter((s) => !liveInsights.some((l) => l.title === s.title));
    return [...liveInsights, ...filler].slice(0, 4);
  }, [liveInsights]);

  return <AiInsightsCard insights={allInsights} footerHref="/pos" />;
}
