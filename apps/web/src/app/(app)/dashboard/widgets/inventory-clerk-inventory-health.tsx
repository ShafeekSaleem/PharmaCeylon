"use client";

import { useMemo } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconArchive, IconBox, IconCalendar } from "@/components/icons";
import { DashboardPanel } from "../components/dashboard-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import { inventoryHealthScore } from "../lib/health-score";
import css from "../dashboard.module.css";

export function InventoryClerkInventoryHealthWidget({ data }: { data: DashboardData }) {
  const { loading, inventory, nearExpiryCount, fastMoversCount } = data;

  const skuCount = inventory?.skuCount ?? 0;
  const healthyPct = skuCount > 0 && inventory ? Math.round((inventory.healthy / skuCount) * 100) : null;

  const health = useMemo(
    () =>
      inventoryHealthScore({
        low: inventory?.lowStock ?? 0,
        dead: 0,
        nearExpiry: nearExpiryCount,
        fast: fastMoversCount ?? 0,
      }),
    [inventory?.lowStock, nearExpiryCount, fastMoversCount],
  );

  const healthSignals = [
    { key: "low", label: "Low stock", value: inventory?.lowStock ?? 0, tone: "warning" as const, href: "/inventory?view=low" },
    {
      key: "out",
      label: "Out of stock",
      value: inventory?.outOfStock ?? 0,
      tone: "danger" as const,
      href: "/inventory?view=out",
    },
    {
      key: "expiry",
      label: "Near expiry ≤30d",
      value: nearExpiryCount,
      tone: "muted" as const,
      href: "/inventory/batches?nearExpiryDays=30",
    },
  ];
  const healthBarMax = Math.max(...healthSignals.map((s) => s.value), 1);
  const mostUrgentKey =
    (inventory?.lowStock ?? 0) >= nearExpiryCount && (inventory?.lowStock ?? 0) >= (inventory?.outOfStock ?? 0)
      ? "low"
      : (inventory?.outOfStock ?? 0) >= nearExpiryCount
        ? "out"
        : "expiry";

  return (
    <DashboardPanel title="Inventory Health" icon={<IconBox size={15} />} compact footerHref="/inventory" footerLabel="Open inventory →">
      {loading && !inventory ? (
        <p className={css.emptyState}>Loading stock health…</p>
      ) : (
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
                {healthyPct != null ? `${inventory?.healthy ?? 0} of ${skuCount} SKUs healthy` : "—"}
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
                        <IconAlertTriangle size={14} strokeWidth={1.75} />
                      ) : signal.key === "out" ? (
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
        </div>
      )}
    </DashboardPanel>
  );
}
