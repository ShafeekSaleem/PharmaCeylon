"use client";

import { AiInsightsCard } from "../components/ai-insights-card";
import { INVENTORY_AI_INSIGHTS } from "../lib/placeholder-data";

export function InventoryClerkAiInsightsWidget() {
  return <AiInsightsCard insights={INVENTORY_AI_INSIGHTS} footerHref="/purchasing" footerLabel="Open purchasing →" />;
}
