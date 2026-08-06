"use client";

import {
  IconAlertTriangle,
  IconBox,
  IconCalendar,
  IconClipboardList,
  IconPackage,
  IconShoppingCart,
  IconTruck,
  IconActivity,
  IconRefresh,
} from "@/components/icons";
import { StatCard, StatusBadge } from "@/components/ui";
import { formatMoney } from "@/app/(app)/inventory/utils";
import {
  OPERATIONS_ROLES,
  PURCHASING_ROLES,
} from "@/lib/role-access";
import { AiInsightsCard } from "../components/ai-insights-card";
import { AlertList } from "../components/alert-list";
import { DashboardPanel } from "../components/dashboard-panel";
import { ProgressBar } from "../components/progress-bar";
import { QuickActionsBar } from "../components/quick-actions-bar";
import { SimpleLineChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import {
  MANAGER_AI_INSIGHTS,
  PLACEHOLDER_SERVICE_ISSUES,
} from "../lib/placeholder-data";
import css from "../dashboard.module.css";

type Props = { data: DashboardData };

export function ManagerDashboard({ data }: Props) {
  const {
    loading,
    inventory,
    todaySalesTotal,
    salesTrendLabel,
    salesTrendPositive,
    monthSalesTotal,
    todayGrossProfit,
    hasMarginData,
    marginPct,
    todaySalesCount,
    salesTrend7d,
    staffProductivity,
    pendingApprovalsTotal,
    pendingPoApprovals,
    pendingTransferApprovals,
    pendingReturnApprovals,
    openTransfers,
    stocktakesInProgress,
    openPoList,
    transferList,
    overduePos,
    nearExpiryCount,
    lowStockRows,
    assignedBranchTargets,
    currentBranchPerf,
    branchPerfYearMonth,
  } = data;

  const targetRows =
    assignedBranchTargets.length > 0
      ? assignedBranchTargets
      : currentBranchPerf
        ? [currentBranchPerf]
        : [];

  const gpRate =
    todaySalesTotal > 0
      ? todayGrossProfit / todaySalesTotal
      : hasMarginData && marginPct != null
        ? marginPct / 100
        : 0.3;
  const profitTrend = salesTrend7d.map((p) => ({
    label: p.label,
    value: Math.round(p.value * gpRate),
  }));
  const gpIsApprox = !hasMarginData;

  const alerts = [
    (inventory?.outOfStock ?? 0) > 0
      ? {
          key: "oos",
          label: "Items out of stock",
          count: inventory!.outOfStock,
          tone: "danger" as const,
          href: "/inventory?view=out",
        }
      : null,
    (inventory?.lowStock ?? 0) > 0
      ? {
          key: "low",
          label: "Low stock items",
          count: inventory!.lowStock,
          tone: "warning" as const,
          href: "/inventory?view=low",
        }
      : null,
    nearExpiryCount > 0
      ? {
          key: "exp",
          label: "Near-expiry batches",
          count: nearExpiryCount,
          tone: "warning" as const,
          href: "/inventory/batches",
        }
      : null,
    overduePos > 0
      ? {
          key: "od",
          label: "Overdue purchase orders",
          count: overduePos,
          tone: "warning" as const,
          href: "/purchasing",
        }
      : null,
    stocktakesInProgress > 0
      ? {
          key: "st",
          label: "Stocktakes in progress",
          count: stocktakesInProgress,
          tone: "info" as const,
          href: "/stocktakes",
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    label: string;
    count: number;
    tone: "danger" | "warning" | "info";
    href: string;
  }>;

  const approvalTasks = [
    pendingPoApprovals > 0
      ? {
          key: "po",
          label: "Purchase orders awaiting approval",
          count: pendingPoApprovals,
          tone: "danger" as const,
          href: "/purchasing",
        }
      : null,
    pendingTransferApprovals > 0
      ? {
          key: "tr-appr",
          label: "Transfers awaiting approval",
          count: pendingTransferApprovals,
          tone: "warning" as const,
          href: "/transfers",
        }
      : null,
    pendingReturnApprovals > 0
      ? {
          key: "ret",
          label: "Returns awaiting approval",
          count: pendingReturnApprovals,
          tone: "warning" as const,
          href: "/returns",
        }
      : null,
    stocktakesInProgress > 0
      ? {
          key: "st",
          label: "Active stocktakes",
          count: stocktakesInProgress,
          tone: "info" as const,
          href: "/stocktakes",
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string;
    label: string;
    count: number;
    tone: "danger" | "warning" | "info";
    href: string;
  }>;

  const healthyPct =
    inventory && inventory.skuCount > 0
      ? Math.round((inventory.healthy / inventory.skuCount) * 1000) / 10
      : null;
  const lowPct =
    inventory && inventory.skuCount > 0
      ? Math.round((inventory.lowStock / inventory.skuCount) * 1000) / 10
      : null;
  const oosPct =
    inventory && inventory.skuCount > 0
      ? Math.round((inventory.outOfStock / inventory.skuCount) * 1000) / 10
      : null;

  return (
    <>
      <div className={css.kpiRow}>
        <StatCard
          title="Today's Sales"
          value={loading ? "…" : formatMoney(todaySalesTotal)}
          subtitle="vs yesterday"
          icon={<IconShoppingCart size={16} strokeWidth={1.75} />}
          iconTone="primary"
          trend={
            salesTrendLabel
              ? {
                  value: salesTrendLabel,
                  direction: salesTrendPositive ? "up" : "down",
                  tone: salesTrendPositive ? "positive" : "danger",
                }
              : undefined
          }
          menuItems={[
            { label: "Open POS", href: "/pos" },
            { label: "View reports", href: "/reports" },
          ]}
        />
        <StatCard
          title="Target Achievement"
          value={
            loading
              ? "…"
              : currentBranchPerf?.achievementPct != null
                ? `${currentBranchPerf.achievementPct.toFixed(0)}%`
                : "—"
          }
          subtitle={
            currentBranchPerf?.targetAmount != null
              ? `MTD ${formatMoney(currentBranchPerf.monthSales)} / ${formatMoney(currentBranchPerf.targetAmount)}`
              : "Assigned by owner"
          }
          icon={<IconActivity size={16} strokeWidth={1.75} />}
          iconTone="success"
          menuItems={[
            { label: "View reports", href: "/reports" },
          ]}
        />
        <StatCard
          title="Pending Approvals"
          value={loading ? "…" : pendingApprovalsTotal}
          subtitle="POs, transfers & returns"
          icon={<IconClipboardList size={16} strokeWidth={1.75} />}
          iconTone="warning"
          trend={
            pendingApprovalsTotal > 0
              ? { value: "Review", direction: "up", tone: "warning" }
              : undefined
          }
          menuItems={[
            { label: "Open purchasing", href: "/purchasing" },
            { label: "View transfers", href: "/transfers" },
            { label: "View returns", href: "/returns" },
          ]}
        />
        <StatCard
          title="Low Stock"
          value={loading ? "…" : (inventory?.lowStock ?? "—")}
          subtitle="Reorder soon"
          icon={<IconAlertTriangle size={16} strokeWidth={1.75} />}
          iconTone="danger"
          trend={
            inventory && inventory.lowStock > 0
              ? { value: "Attention", direction: "up", tone: "danger" }
              : undefined
          }
          menuItems={[
            { label: "View low stock", href: "/inventory?view=low" },
            { label: "Open inventory", href: "/inventory" },
          ]}
        />
        <StatCard
          title="Open Transfers"
          value={loading ? "…" : openTransfers}
          subtitle="Requested · approved · in transit"
          icon={<IconTruck size={16} strokeWidth={1.75} />}
          iconTone="info"
          menuItems={[
            { label: "View transfers", href: "/transfers" },
            { label: "Open inventory", href: "/inventory" },
          ]}
        />
        <StatCard
          title="Stocktakes in Progress"
          value={loading ? "…" : stocktakesInProgress}
          subtitle="Active counts"
          icon={<IconBox size={16} strokeWidth={1.75} />}
          iconTone="primary"
          menuItems={[
            { label: "Open stocktakes", href: "/stocktakes" },
            { label: "Open inventory", href: "/inventory" },
          ]}
        />
      </div>

      <div className={css.grid3}>
        <DashboardPanel
          title="Branch Performance Overview"
          className={css.span2}
          headerRight={<span className={css.filterChip}>This week</span>}
        >
          <SimpleLineChart
            points={salesTrend7d}
            secondaryPoints={profitTrend}
            aLabel="Sales"
            bLabel={gpIsApprox ? "Gross profit (approx)" : "Gross profit"}
            formatValue={(n) => formatMoney(n)}
          />
          <div className={css.inlineStats}>
            <span>
              Total Sales (30d): <strong>{formatMoney(monthSalesTotal)}</strong>
            </span>
            <span>
              Gross Profit ({gpIsApprox ? "approx" : "est."} today):{" "}
              <strong>{formatMoney(todayGrossProfit)}</strong>
              {marginPct != null ? (
                <span className={css.muted}> · {marginPct.toFixed(1)}% margin</span>
              ) : null}
            </span>
            <span>
              Transactions today: <strong>{todaySalesCount}</strong>
            </span>
          </div>
          {gpIsApprox ? (
            <p className={css.placeholderNote}>
              GP companion line is approximate (no margin report rate yet).
            </p>
          ) : (
            <p className={`${css.muted} ${css.caption} ${css.stackMtXs}`}>
              GP line uses recent margin-by-product rate applied to daily sales.
            </p>
          )}
        </DashboardPanel>

        <DashboardPanel title="Inventory Health" footerHref="/inventory" footerLabel="View inventory →">
          <div className={css.healthPills}>
            <span className={`${css.healthPill} ${css.healthPill_neutral}`}>
              Total SKUs
              <strong>{inventory?.skuCount ?? "—"}</strong>
            </span>
            <span className={`${css.healthPill} ${css.healthPill_success}`}>
              Healthy{healthyPct != null ? ` ${healthyPct}%` : ""}
              <strong>{inventory?.healthy ?? "—"}</strong>
            </span>
            <span className={`${css.healthPill} ${css.healthPill_warning}`}>
              Low{lowPct != null ? ` ${lowPct}%` : ""}
              <strong>{inventory?.lowStock ?? "—"}</strong>
            </span>
            <span className={`${css.healthPill} ${css.healthPill_danger}`}>
              Out{oosPct != null ? ` ${oosPct}%` : ""}
              <strong>{inventory?.outOfStock ?? "—"}</strong>
            </span>
          </div>
          <div className={css.metricTiles}>
            <div className={css.metricTileWide}>
              <span>Stock Value</span>
              <strong>{inventory ? formatMoney(inventory.stockValue) : "—"}</strong>
            </div>
          </div>
        </DashboardPanel>
      </div>

      <div className={css.grid3}>
        <DashboardPanel
          title="Branch Sales vs Target"
          footerMeta={
            branchPerfYearMonth ? `Month ${branchPerfYearMonth}` : undefined
          }
        >
          {targetRows.length === 0 ? (
            <p className={css.emptyState}>
              No monthly target assigned yet. Owners set branch targets and
              assign a manager for performance.
            </p>
          ) : (
            <table className={css.salesTable}>
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>MTD sales</th>
                  <th>Target</th>
                  <th>Achievement</th>
                </tr>
              </thead>
              <tbody>
                {targetRows.map((row) => {
                  const pct = row.achievementPct;
                  const bar = pct != null ? Math.min(120, Math.max(0, pct)) : 0;
                  const tone =
                    pct == null
                      ? "primary"
                      : pct >= 100
                        ? "success"
                        : pct >= 70
                          ? "primary"
                          : "warning";
                  return (
                    <tr key={row.branchId}>
                      <td>
                        <div>{row.name}</div>
                        <span className={css.muted}>
                          Today {formatMoney(row.todaySales)}
                        </span>
                      </td>
                      <td>{formatMoney(row.monthSales)}</td>
                      <td className={css.muted}>
                        {row.targetAmount != null
                          ? formatMoney(row.targetAmount)
                          : "—"}
                      </td>
                      <td>
                        {pct != null ? (
                          <ProgressBar
                            value={bar}
                            label={`${pct.toFixed(0)}%`}
                            tone={tone}
                          />
                        ) : (
                          <span className={css.muted}>No target</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </DashboardPanel>

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
                  const share =
                    todaySalesTotal > 0 ? Math.round((row.sales / todaySalesTotal) * 100) : 0;
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

        <DashboardPanel
          title="Approvals & Tasks"
          footerHref="/purchasing"
          footerLabel="Open purchasing →"
        >
          <AlertList
            showAction
            emptyText="No pending approvals or active stocktakes."
            alerts={approvalTasks}
          />
        </DashboardPanel>
      </div>

      <div className={css.grid3}>
        <DashboardPanel
          title="Transfer & PO Pipeline"
          footerHref="/purchasing"
          footerLabel="Open pipeline →"
        >
          {openPoList.length === 0 && transferList.length === 0 ? (
            <p className={css.emptyState}>No open pipeline items.</p>
          ) : (
            <ul className={css.pipelineList}>
              {openPoList.map((po) => (
                <li key={po.id}>
                  <div>
                    <strong>{po.poNumber}</strong>
                    <span className={css.muted}>{po.supplier.name}</span>
                  </div>
                  <StatusBadge status={po.status} />
                </li>
              ))}
              {transferList.slice(0, 4).map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.transferNumber}</strong>
                    <span className={css.muted}>
                      {[t.fromBranch?.name, t.toBranch?.name].filter(Boolean).join(" → ") ||
                        "Transfer"}
                    </span>
                  </div>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>

        <DashboardPanel title="Operational Alerts">
          <AlertList alerts={alerts} emptyText="No operational alerts right now." showAction />
          {lowStockRows.length > 0 ? (
            <ul className={`${css.simpleList} ${css.stackMtMd}`}>
              {lowStockRows.slice(0, 4).map((r) => (
                <li key={r.productId}>
                  <span>{r.product.name}</span>
                  <span className={css.muted}>
                    {r.qtyOnHand} / min {r.product.reorderLevel}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </DashboardPanel>

        <DashboardPanel
          title="Customer Service Issues"
          headerRight={<span className={css.placeholderBadge}>Sample</span>}
        >
          <p className={css.placeholderNote}>Ops task board coming soon — sample priorities shown.</p>
          <ul className={css.issueList}>
            {PLACEHOLDER_SERVICE_ISSUES.map((issue) => (
              <li key={issue.id}>
                <span>{issue.label}</span>
                <span className={`${css.priorityPill} ${css[`priority_${issue.priority}`]}`}>
                  {issue.priority}
                </span>
              </li>
            ))}
          </ul>
        </DashboardPanel>
      </div>

      <AiInsightsCard insights={MANAGER_AI_INSIGHTS} layout="cards" />

      <QuickActionsBar
        title="Manager Quick Actions"
        actions={[
          {
            href: "/purchasing?status=pending_approval",
            label: "Approve POs",
            icon: <IconClipboardList size={18} />,
            roles: PURCHASING_ROLES,
            tone: "warning",
          },
          {
            href: "/transfers?status=requested",
            label: "Transfer approvals",
            icon: <IconTruck size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
          {
            href: "/returns?status=pending_approval",
            label: "Return approvals",
            icon: <IconRefresh size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
          {
            href: "/purchasing?action=create-po",
            label: "Create PO",
            icon: <IconShoppingCart size={18} />,
            roles: PURCHASING_ROLES,
            tone: "primary",
          },
          {
            href: "/inventory?view=low",
            label: "Low stock queue",
            icon: <IconAlertTriangle size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "warning",
          },
          {
            href: "/inventory/batches?nearExpiryDays=30",
            label: "Near expiry",
            icon: <IconCalendar size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "danger",
          },
          {
            href: "/inventory?openAdjustment=1",
            label: "Adjust stock",
            icon: <IconPackage size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "success",
          },
          {
            href: "/transfers?action=create",
            label: "Request transfer",
            icon: <IconBox size={18} />,
            roles: OPERATIONS_ROLES,
            tone: "info",
          },
        ]}
      />
    </>
  );
}
