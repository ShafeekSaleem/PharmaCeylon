"use client";

import { useMemo } from "react";
import { AiInsightsCard } from "../components/ai-insights-card";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { buildManagerInsights } from "../lib/insight-builders";

export function ManagerAiInsightsWidget({ data }: { data: DashboardData }) {
  const allInsights = useMemo(() => buildManagerInsights(data).slice(0, 4), [data]);

  return <AiInsightsCard insights={allInsights} footerHref="/insights" pageSize={3} />;
}
