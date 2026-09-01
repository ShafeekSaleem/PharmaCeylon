"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/alert";
import { PageHeader, ActionButton } from "@/components/ui";
import { IconRefresh } from "@/components/icons";
import { useRoleAccess } from "@/lib/use-role-access";
import { ActionsPanel } from "@/app/(app)/reports/components/actions-panel";
import type { Scope } from "@/app/(app)/reports/lib/types";
import { insightToActionPanelItem } from "../dashboard/components/ai-insights-card";
import { useDashboardData } from "../dashboard/hooks/use-dashboard-data";
import { PeriodToggle } from "../dashboard/components/period-toggle";
import { resolvePrimaryDashboardRole } from "../dashboard/lib/dashboard-role";
import { buildCashierInsights, buildManagerInsights, buildOwnerInsights } from "../dashboard/lib/insight-builders";
import {
  INVENTORY_AI_INSIGHTS,
  PHARMACIST_AI_INSIGHTS,
  type AiInsight,
  type AiInsightCategory,
} from "../dashboard/lib/placeholder-data";
import { OWNER_SCOPE_OPTIONS, type OwnerAnalyticsScope } from "../dashboard/hooks/use-dashboard-data";
import { useReportSourcedInsights } from "./hooks/use-report-sourced-insights";
import css from "./insights.module.css";

const CATEGORY_LABEL: Record<AiInsightCategory, string> = {
  sales: "Sales",
  profitability: "Profitability",
  inventory: "Inventory",
  purchasing: "Purchasing",
  operations: "Operations",
  clinical: "Clinical",
};
const CATEGORY_ORDER: AiInsightCategory[] = ["inventory", "purchasing", "sales", "profitability", "clinical", "operations"];

const TONE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All severities" },
  { value: "danger", label: "Danger" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "success", label: "Success" },
];

export default function InsightsPage() {
  const router = useRouter();
  const { userRoles } = useRoleAccess();
  const data = useDashboardData();
  const viewRole = useMemo(() => resolvePrimaryDashboardRole(userRoles), [userRoles]);
  const isOwner = viewRole === "owner";

  const roleInsights: AiInsight[] = useMemo(() => {
    switch (viewRole) {
      case "owner":
        return buildOwnerInsights(data);
      case "manager":
        return buildManagerInsights(data);
      case "cashier":
        return buildCashierInsights(data);
      case "pharmacist":
        return PHARMACIST_AI_INSIGHTS;
      case "inventory_clerk":
        return INVENTORY_AI_INSIGHTS;
      default:
        return [];
    }
  }, [viewRole, data]);

  const reportScope: Scope = isOwner && data.ownerScope === "all_branches" ? "tenant" : "branch";
  const { items: reportItems, loading: reportLoading } = useReportSourcedInsights(
    data.canViewReports,
    reportScope,
    isOwner,
  );

  const allItems = useMemo(() => [...roleInsights, ...reportItems], [roleInsights, reportItems]);

  const [categoryFilter, setCategoryFilter] = useState<"all" | AiInsightCategory>("all");
  const [toneFilter, setToneFilter] = useState<string>("all");

  const availableCategories = useMemo(() => {
    const present = new Set(allItems.map((i) => i.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [allItems]);

  const categoryOptions = useMemo(
    () => [{ value: "all", label: `All (${allItems.length})` }, ...availableCategories.map((c) => ({
      value: c,
      label: `${CATEGORY_LABEL[c]} (${allItems.filter((i) => i.category === c).length})`,
    }))],
    [allItems, availableCategories],
  );

  const filteredItems = useMemo(
    () =>
      allItems.filter(
        (i) =>
          (categoryFilter === "all" || i.category === categoryFilter) &&
          (toneFilter === "all" || (i.tone ?? "info") === toneFilter),
      ),
    [allItems, categoryFilter, toneFilter],
  );

  return (
    <div className={css.page}>
      <PageHeader
        title="AI Insights & Recommendations"
        description="Everything that needs your attention, in one place — reorder alerts, near-expiry stock, supply delays, branch performance, and more."
        actions={
          <ActionButton variant="secondary" icon={<IconRefresh size={14} />} onClick={() => void data.reload()}>
            Refresh
          </ActionButton>
        }
      />

      {!data.branchId ? <Alert variant="warning">Select a branch in the header to load insights.</Alert> : null}
      {data.error ? <Alert variant="error">{data.error}</Alert> : null}

      <div className={css.filterRow}>
        <span className={css.filterLabel}>Category</span>
        <PeriodToggle
          aria-label="Filter by category"
          value={categoryFilter}
          options={categoryOptions}
          onChange={(v) => setCategoryFilter(v as "all" | AiInsightCategory)}
        />
      </div>

      <div className={css.filterRow}>
        <span className={css.filterLabel}>Severity</span>
        <PeriodToggle aria-label="Filter by severity" value={toneFilter} options={TONE_OPTIONS} onChange={setToneFilter} />
      </div>

      {isOwner ? (
        <div className={css.filterRow}>
          <span className={css.filterLabel}>Branch scope</span>
          <PeriodToggle
            aria-label="Branch scope"
            value={data.ownerScope}
            options={OWNER_SCOPE_OPTIONS}
            onChange={(v) => data.setOwnerScope(v as OwnerAnalyticsScope)}
          />
        </div>
      ) : null}

      <ActionsPanel
        title={
          data.loading || reportLoading
            ? "Loading insights…"
            : `${filteredItems.length} insight${filteredItems.length === 1 ? "" : "s"}`
        }
        items={filteredItems.map((i) => insightToActionPanelItem(i, router.push))}
        variant="cards"
        pageSize={12}
      />
    </div>
  );
}
