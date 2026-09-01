"use client";

import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { ProgressBar } from "../components/progress-bar";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

export function ManagerStaffProductivityWidget({ data }: { data: DashboardData }) {
  const { staffProductivity, todaySalesTotal } = data;

  return (
    <DashboardPanel title="Staff Productivity">
      {staffProductivity.length === 0 ? (
        <p className={css.emptyState}>No counter activity yet today.</p>
      ) : (
        <table className={css.salesTable}>
          <thead>
            <tr>
              <th>Staff</th>
              <th>Sales</th>
              <th>Txns</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {staffProductivity.map((row) => {
              const share = todaySalesTotal > 0 ? Math.round((row.sales / todaySalesTotal) * 100) : 0;
              const avg = row.transactions > 0 ? row.sales / row.transactions : 0;
              return (
                <tr key={row.id}>
                  <td>
                    <div>{row.name}</div>
                    <span className={css.muted}>Avg {formatMoney(avg)}</span>
                  </td>
                  <td>{formatMoney(row.sales)}</td>
                  <td>{row.transactions}</td>
                  <td>
                    <ProgressBar value={share} label={`${share}%`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </DashboardPanel>
  );
}
