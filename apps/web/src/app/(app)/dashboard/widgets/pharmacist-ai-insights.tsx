"use client";

import { AiInsightsCard } from "../components/ai-insights-card";
import { PHARMACIST_AI_INSIGHTS } from "../lib/placeholder-data";

export function PharmacistAiInsightsWidget() {
  return <AiInsightsCard title="AI Clinical Insights" insights={PHARMACIST_AI_INSIGHTS} />;
}
