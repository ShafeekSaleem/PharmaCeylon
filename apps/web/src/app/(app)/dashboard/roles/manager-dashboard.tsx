"use client";

import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardCanvas } from "../components/dashboard-canvas";
import { DashboardFixedGrid } from "../components/dashboard-fixed-grid";
import { KeyFigures } from "../components/key-figures";
import { useSalesZeroNote } from "../lib/sales-zero";
import {
  isDashboardServerUnreachable,
  isMetricUnavailable,
} from "../lib/dashboard-connectivity";
import type { DashboardData } from "../hooks/use-dashboard-data";
import type { UseDashboardLayoutResult } from "../hooks/use-dashboard-layout";
import type { WidgetDef } from "../widgets/types";
import css from "../dashboard.module.css";

type Props = {
  data: DashboardData;
  catalog: WidgetDef[];
  layout: UseDashboardLayoutResult;
  refreshKey: string | null;
  counterLive: boolean;
};

export function ManagerDashboard({
  data,
  catalog,
  layout,
  refreshKey,
  counterLive,
}: Props) {
  const {
    loading,
    todaySalesTotal,
    todaySalesCount,
    currentBranchPerf,
    dispensedToday,
    dispensedTrendLabel,
    failedSections,
  } = data;

  const serverUnreachable = isDashboardServerUnreachable(data);
  const salesUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Sales metrics"],
  );
  const branchPerfUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Branch Performance", "Sales overview"],
  );

  const salesZero = !loading && !salesUnavailable && todaySalesTotal === 0;
  const zeroNote = useSalesZeroNote(
    data.branchId,
    salesZero,
    data.canViewReports,
    refreshKey,
  );

  return (
    <>
      <KeyFigures
        loading={loading}
        figures={[
          {
            key: "sales",
            label: "Sales today",
            value: formatMoney(todaySalesTotal),
            unavailable: salesUnavailable,
            note: salesZero
              ? zeroNote.text
              : `${todaySalesCount} sale${todaySalesCount === 1 ? "" : "s"} so far`,
            noteWarning: salesZero && zeroNote.warning,
          },
          {
            key: "target",
            label: "Target this month",
            value:
              currentBranchPerf?.achievementPct != null
                ? `${currentBranchPerf.achievementPct.toFixed(0)}%`
                : "—",
            unavailable: branchPerfUnavailable,
            note:
              currentBranchPerf?.targetAmount != null
                ? `${formatMoney(currentBranchPerf.monthSales)} of ${formatMoney(currentBranchPerf.targetAmount)}`
                : "No target set by the owner",
            href: "/reports?category=sales&report=branch-sales",
            linkLabel: "Branch sales",
          },
          {
            key: "units",
            label: "Units sold today",
            value: dispensedToday,
            unavailable: salesUnavailable,
            note:
              dispensedToday > 0 && dispensedTrendLabel
                ? `${dispensedTrendLabel} on yesterday`
                : undefined,
          },
        ]}
      />

      <DashboardFixedGrid
        role="manager"
        data={data}
        refreshKey={refreshKey}
        counterLive={counterLive}
      />

      <div className={css.optionalWidgets}>
        <DashboardCanvas
          catalog={catalog}
          layout={layout.layout}
          data={data}
          isEditing={layout.isEditing}
          loading={layout.loading}
          onLayoutChange={layout.updateLayout}
          onRemoveWidget={layout.removeWidget}
        />
      </div>
    </>
  );
}