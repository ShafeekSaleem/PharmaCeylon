"use client";

import { useMemo } from "react";
import { AiInsightsCard } from "../components/ai-insights-card";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { buildOwnerInsights } from "../lib/insight-builders";

export function OwnerAiInsightsWidget({ data }: { data: DashboardData }) {
  const allInsights = useMemo(() => buildOwnerInsights(data).slice(0, 5), [data]);

  return <AiInsightsCard insights={allInsights} footerHref="/insights" pageSize={3} />;
}
