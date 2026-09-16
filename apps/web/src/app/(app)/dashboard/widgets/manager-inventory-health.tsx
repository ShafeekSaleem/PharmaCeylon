"use client";

import { useMemo } from "react";
import Link from "next/link";
import { IconActivity, IconArchive, IconBox, IconCalendar, IconPackage } from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { inventoryHealthScore } from "../lib/health-score";
import css from "../dashboard.module.css";

export function ManagerInventoryHealthWidget({ data }: { data: DashboardData }) {
  const { loading, inventory, nearExpiryCount, deadStockCount, fastMoversCount } = data;

  const lowN = inventory?.lowStock ?? 0;
  const deadN = deadStockCount ?? 0;
  const fastN = fastMoversCount ?? 0;
  const health = useMemo(
    () => inventoryHealthScore({ low: lowN, dead: deadN, nearExpiry: nearExpiryCount, fast: fastN }),
    [deadN, fastN, lowN, nearExpiryCount],
  );
  const attentionCount = lowN + deadN + nearExpiryCount;
  const healthBarMax = Math.max(lowN, deadN, nearExpiryCount, 1);
  const mostUrgentKey =
    lowN >= nearExpiryCount && lowN >= deadN ? "low" : nearExpiryCount >= deadN ? "expiry" : "dead";
  const healthSignals = [
    { key: "low", label: "Low stock", value: lowN, tone: "danger" as const, href: "/inventory?view=low" },
    {
      key: "dead",
      label: "Dead stock",
      value: deadN,
      tone: "muted" as const,
      href: "/reports?category=inventory&report=stock-health",
    },
    {
      key: "expiry",
      label: "Near expiry ≤30d",
      value: nearExpiryCount,
      tone: "warning" as const,
      href: "/inventory/batches?nearExpiryDays=30",
    },
  ];

  return (
    <DashboardPanel title="Inventory Health" icon={<IconPackage size={15} />} compact>
      <div className={css.healthBoard}>
        <div className={css.healthTop}>
          <div
            className={`${css.healthRing} ${css[`healthRing_${health.tone}`]}`}
            style={{ "--score": loading ? 0 : health.score } as React.CSSProperties}
          >
            <span>{loading ? "…" : health.score}</span>
          </div>
          <div className={css.healthTopCopy}>
            <span className={css.healthTopTitle}>{loading ? "…" : health.label}</span>
            <span className={css.healthTopMeta}>
              {loading
                ? "Loading signals…"
                : `${attentionCount} signal${attentionCount === 1 ? "" : "s"} need attention · This branch`}
            </span>
            <span className={css.healthTopValue}>
              Stock value:{" "}
              <strong>
                {loading ? "…" : inventory?.stockValue != null ? formatMoney(inventory.stockValue) : "—"}
              </strong>
            </span>
          </div>
        </div>

        <ul className={css.healthFlatList}>
          {healthSignals.map((signal) => {
            const pct =
              loading || signal.value === 0 ? 0 : Math.max(8, Math.round((signal.value / healthBarMax) * 100));
            return (
              <li key={signal.key}>
                <Link href={signal.href} className={css.healthFlatRow}>
                  <span
                    className={`${css.healthSignalIcon} ${css[`healthSignalIcon_${signal.tone}`]}`}
                    aria-hidden
                  >
                    {signal.key === "low" ? (
                      <IconBox size={14} strokeWidth={1.75} />
                    ) : signal.key === "dead" ? (
                      <IconArchive size={14} strokeWidth={1.75} />
                    ) : (
                      <IconCalendar size={14} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className={css.healthSignalLead}>
                    <span className={css.healthSignalLabel}>{signal.label}</span>
                    {signal.key === mostUrgentKey && signal.value > 0 ? (
                      <span className={css.healthUrgentBadge}>Urgent</span>
                    ) : null}
                  </span>
                  <span className={css.healthSignalTrack}>
                    <span
                      className={`${css.healthSignalFill} ${css[`healthSignalFill_${signal.tone}`]}`}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className={`${css.healthSignalValue} ${css[`healthSignalValue_${signal.tone}`]}`}>
                    {loading ? "…" : signal.value}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>

        {loading ? null : (
          <Link href="/inventory/movements?category=sales" className={css.healthPositiveCallout}>
            <IconActivity size={16} strokeWidth={2.2} aria-hidden />
            <span className={css.healthPositiveText}>
              <strong>{fastMoversCount ?? 0}</strong> fast movers today — moving well, no action needed.
            </span>
          </Link>
        )}

        <div className={css.healthActions}>
          <div className={css.healthActionsRow}>
            <Link href="/reports?category=inventory&report=stock-health" className={css.healthReportLink}>
              View inventory report →
            </Link>
            <div className={css.healthActionBtns}>
              <Link href="/inventory?view=low" className={`${css.healthActionBtn} ${css.healthActionBtn_primary}`}>
                <IconBox size={13} strokeWidth={1.75} aria-hidden />
                Review low stock
              </Link>
              <Link
                href="/inventory/batches?nearExpiryDays=30"
                className={`${css.healthActionBtn} ${css.healthActionBtn_warning}`}
              >
                <IconCalendar size={13} strokeWidth={1.75} aria-hidden />
                View expiring
              </Link>
            </div>
          </div>
        </div>
      </div>
    </DashboardPanel>
  );
}
