"use client";

import Link from "next/link";
import { IconClipboardList } from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { DashboardPanel } from "../components/dashboard-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

const SCOPE_LABEL: Record<string, string> = {
  full: "Full-branch count",
  cycle: "Cycle count",
  near_expiry: "Near-expiry count",
  quarantined: "Quarantined items",
  zero_stock: "Zero-stock count",
  custom: "Custom count",
};

export function InventoryClerkStocktakesWidget({ data }: { data: DashboardData }) {
  const {
    loading,
    stocktakesActiveCount,
    stocktakesScheduledCount,
    stocktakesCompletedCount,
    stocktakeList,
  } = data;

  return (
    <DashboardPanel
      title="Stocktakes"
      subtitle="Cycle counts · this branch"
      icon={<IconClipboardList size={15} />}
      compact
      footerHref="/stocktakes"
      footerLabel="Open stocktakes →"
    >
      <div className={css.teamStatStrip} style={{ marginBottom: "0.65rem" }}>
        <div className={css.teamStatCell}>
          <div className={css.teamStatCopy}>
            <strong className={css.teamStatValue}>{loading ? "…" : stocktakesActiveCount}</strong>
            <span className={css.teamStatLabel}>In progress</span>
          </div>
        </div>
        <div className={css.teamStatCell}>
          <div className={css.teamStatCopy}>
            <strong className={css.teamStatValue}>{loading ? "…" : stocktakesScheduledCount}</strong>
            <span className={css.teamStatLabel}>Scheduled</span>
          </div>
        </div>
        <div className={css.teamStatCell}>
          <div className={css.teamStatCopy}>
            <strong className={`${css.teamStatValue} ${css.teamStatValue_success}`}>
              {loading ? "…" : stocktakesCompletedCount}
            </strong>
            <span className={css.teamStatLabel}>Completed</span>
          </div>
        </div>
      </div>

      {stocktakeList.length === 0 ? (
        <p className={css.emptyState}>No stocktakes on record.</p>
      ) : (
        <ul className={css.pipelineList}>
          {stocktakeList.map((s) => (
            <li key={s.id}>
              <Link href={`/stocktakes/${s.id}`}>
                <span className={`${css.pipelineIcon} ${css.pipelineIcon_stocktake}`} aria-hidden>
                  <IconClipboardList size={14} strokeWidth={1.75} />
                </span>
                <span className={css.pipelineRowBody}>
                  <strong>{s.title || s.stocktakeNumber || "Stocktake"}</strong>
                  <span className={css.muted}>{s.areaLabel || SCOPE_LABEL[s.scope ?? ""] || "Stocktake"}</span>
                </span>
                <StatusBadge status={s.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DashboardPanel>
  );
}
