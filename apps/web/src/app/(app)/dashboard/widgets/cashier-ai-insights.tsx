"use client";

import { useMemo } from "react";
import { AiInsightsCard } from "../components/ai-insights-card";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { buildCashierInsights } from "../lib/insight-builders";

export function CashierAiInsightsWidget({ data }: { data: DashboardData }) {
  const allInsights = useMemo(() => buildCashierInsights(data).slice(0, 4), [data]);

  return <AiInsightsCard insights={allInsights} footerHref="/insights" pageSize={3} />;
}
