"use client";

import Link from "next/link";
import { IconAlertTriangle, IconCalendar, IconPackage } from "@/components/icons";
import { DashboardPanel } from "../components/dashboard-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

export function PharmacistControlledDrugActivityWidget({ data }: { data: DashboardData }) {
  const { loading, controlledAttentionCount, controlledLowStockCount, controlledNearExpiryCount } = data;

  const controlledBarMax = Math.max(controlledAttentionCount, controlledLowStockCount, controlledNearExpiryCount, 1);
  const controlledMostUrgentKey =
    controlledAttentionCount >= controlledLowStockCount && controlledAttentionCount >= controlledNearExpiryCount
      ? "flagged"
      : controlledLowStockCount >= controlledNearExpiryCount
        ? "lowstock"
        : "nearexpiry";
  const controlledSignals = [
    {
      key: "flagged",
      label: "CD alerts flagged",
      value: controlledAttentionCount,
      tone: "danger" as const,
      href: "/inventory?controlled=controlled",
    },
    {
      key: "lowstock",
      label: "CD low stock",
      value: controlledLowStockCount,
      tone: "warning" as const,
      href: "/inventory?view=low&controlled=controlled",
    },
    {
      key: "nearexpiry",
      label: "CD near expiry",
      value: controlledNearExpiryCount,
      tone: "muted" as const,
      href: "/inventory/batches?nearExpiryDays=30&controlled=controlled",
    },
  ];

  return (
    <DashboardPanel
      title="Controlled Drug Activity"
      subtitle="Today · scheduled substances"
      footerHref="/inventory?controlled=controlled"
      footerLabel="Review controlled inventory →"
    >
      <ul className={css.healthFlatList}>
        {controlledSignals.map((signal) => {
          const pct =
            loading || signal.value === 0
              ? 0
              : Math.max(8, Math.round((signal.value / controlledBarMax) * 100));
          return (
            <li key={signal.key}>
              <Link href={signal.href} className={css.healthFlatRow}>
                <span className={`${css.healthSignalIcon} ${css[`healthSignalIcon_${signal.tone}`]}`} aria-hidden>
                  {signal.key === "flagged" ? (
                    <IconAlertTriangle size={14} strokeWidth={1.75} />
                  ) : signal.key === "lowstock" ? (
                    <IconPackage size={14} strokeWidth={1.75} />
                  ) : (
                    <IconCalendar size={14} strokeWidth={1.75} />
                  )}
                </span>
                <span className={css.healthSignalLead}>
                  <span className={css.healthSignalLabel}>{signal.label}</span>
                  {signal.key === controlledMostUrgentKey && signal.value > 0 ? (
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
    </DashboardPanel>
  );
}
