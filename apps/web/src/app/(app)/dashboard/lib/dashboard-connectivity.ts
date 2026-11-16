import type { DashboardData } from "../hooks/use-dashboard-data";
import { widgetDataSources } from "./widget-data-sources";

const CORE_OUTAGE_SECTIONS = [
  "Sales metrics",
  "Stock metrics",
  "Inventory summary",
] as const;

export function isDashboardServerUnreachable(
  data: Pick<
    DashboardData,
    "branchId" | "loading" | "error" | "failedSections"
  >,
): boolean {
  if (!data.branchId || data.loading) return false;
  if (data.error) return true;
  return CORE_OUTAGE_SECTIONS.every((section) =>
    data.failedSections.has(section),
  );
}

export function isFixedWidgetUnavailable(
  widgetKey: string,
  data: Pick<DashboardData, "failedSections">,
  serverUnreachable: boolean,
): boolean {
  if (serverUnreachable) return true;
  const sources = widgetDataSources(widgetKey);
  if (!sources.length) return false;
  return sources.some((source) => data.failedSections.has(source));
}

export function isMetricUnavailable(
  failedSections: Set<string>,
  serverUnreachable: boolean,
  sections: string[],
): boolean {
  if (serverUnreachable) return true;
  return sections.some((section) => failedSections.has(section));
}