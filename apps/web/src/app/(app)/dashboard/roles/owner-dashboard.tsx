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

export function OwnerDashboard({
  data,
  catalog,
  layout,
  refreshKey,
  counterLive,
}: Props) {
  const {
    loading,
    ownerTodaySalesTotal,
    ownerTodayTxnCount,
    ownerGrossProfit30d,
    hasMarginData,
    marginPct,
    financial,
    failedSections,
  } = data;

  const serverUnreachable = isDashboardServerUnreachable(data);
  const salesUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Sales metrics"],
  );
  const marginUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Product margins"],
  );
  const financialUnavailable = isMetricUnavailable(
    failedSections,
    serverUnreachable,
    ["Financial Snapshot"],
  );

  const salesZero = !loading && !salesUnavailable && ownerTodaySalesTotal === 0;
  const zeroNote = useSalesZeroNote(
    data.branchId,
    salesZero,
    data.canViewReports,
    refreshKey,
  );
  const txnLabel = `${ownerTodayTxnCount} sale${ownerTodayTxnCount === 1 ? "" : "s"} so far`;

  return (
    <>
      <KeyFigures
        loading={loading}
        figures={[
          {
            key: "sales",
            label: "Sales today",
            value: formatMoney(ownerTodaySalesTotal),
            unavailable: salesUnavailable,
            note: salesZero ? zeroNote.text : txnLabel,
            noteWarning: salesZero && zeroNote.warning,
          },
          {
            key: "gp",
            label: "Gross profit · 30 days",
            value: hasMarginData ? formatMoney(ownerGrossProfit30d) : "—",
            unavailable: marginUnavailable,
            note:
              hasMarginData && marginPct != null
                ? `Margin ${marginPct.toFixed(1)}%`
                : "No margin data yet",
            href: "/reports?category=profitability&report=gross-profit",
            linkLabel: "Margin report",
          },
          {
            key: "recv",
            label: "Credit sales recorded",
            value: financial
              ? formatMoney(financial.receivablesOutstanding)
              : "—",
            unavailable: financialUnavailable,
            note: financial
              ? `${financial.receivablesCustomerCount} customer${financial.receivablesCustomerCount === 1 ? "" : "s"}`
              : undefined,
          },
          {
            key: "payables",
            label: "Owed to suppliers",
            value: financial ? formatMoney(financial.payablesOutstanding) : "—",
            unavailable: financialUnavailable,
            note: financial
              ? `${financial.payablesSupplierCount} supplier${financial.payablesSupplierCount === 1 ? "" : "s"}`
              : undefined,
            href: "/suppliers",
            linkLabel: "Suppliers",
          },
        ]}
      />

      <DashboardFixedGrid
        role="owner"
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