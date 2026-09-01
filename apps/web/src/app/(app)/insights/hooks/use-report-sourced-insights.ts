"use client";

import { useEffect, useState } from "react";
import {
  fetchPurchaseSummary,
  fetchStockMovement,
  fetchStocktakesReport,
  fetchSupplierPerformance,
  fetchSupplierSpend,
  fetchTransfersReport,
} from "@/app/(app)/reports/lib/fetchers";
import type { Scope } from "@/app/(app)/reports/lib/types";
import type { AiInsight, AiInsightCategory } from "@/app/(app)/dashboard/lib/placeholder-data";

const DAYS = 30;

/** The 6 report sections whose backend already returns a typed `insights[]` array alongside
 * its report payload (see `apps/api/src/reports/reports.service.ts`) — the only report-sourced
 * insights cheap enough to merge into the hub today without mounting the other 14 sections'
 * full chart/table data-fetches. Each entry maps that report's plain `{key,title,description,
 * countLabel}` shape onto the shared `AiInsight` type with a category tag and a synthesized
 * deep link back to the source report (the backend items carry no frontend href). */
const SOURCES: Array<{
  key: string;
  category: AiInsightCategory;
  href: string;
  fetch: (days: number, scope: Scope, isOwner: boolean) => Promise<{ insights: { key: string; title: string; description: string; countLabel: string }[] }>;
}> = [
  { key: "stock-movement", category: "inventory", href: "/reports?category=inventory&report=stock-movement", fetch: fetchStockMovement },
  { key: "transfers-report", category: "inventory", href: "/reports?category=inventory&report=transfers-report", fetch: (days) => fetchTransfersReport(days) },
  { key: "stocktakes-report", category: "inventory", href: "/reports?category=inventory&report=stocktakes-report", fetch: fetchStocktakesReport },
  { key: "purchase-summary", category: "purchasing", href: "/reports?category=purchasing&report=purchase-summary", fetch: fetchPurchaseSummary },
  { key: "supplier-spend", category: "purchasing", href: "/reports?category=purchasing&report=supplier-spend", fetch: fetchSupplierSpend },
  { key: "supplier-performance", category: "purchasing", href: "/reports?category=purchasing&report=supplier-performance", fetch: fetchSupplierPerformance },
];

/** Owner/manager only — gate the call with `canViewReports` before mounting this hook's effect
 * (or just don't call it) so the fetch never fires for roles without `reports.view`. */
export function useReportSourcedInsights(enabled: boolean, scope: Scope, isOwner: boolean) {
  const [items, setItems] = useState<AiInsight[]>([]);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled(SOURCES.map((s) => s.fetch(DAYS, scope, isOwner))).then((results) => {
      if (cancelled) return;
      const next: AiInsight[] = [];
      results.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        const source = SOURCES[i]!;
        for (const insight of result.value.insights) {
          next.push({
            id: `report-${source.key}-${insight.key}`,
            title: insight.title,
            detail: insight.description,
            tone: "info",
            category: source.category,
            href: source.href,
            countText: insight.countLabel,
          });
        }
      });
      setItems(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, scope, isOwner]);

  return { items, loading };
}
