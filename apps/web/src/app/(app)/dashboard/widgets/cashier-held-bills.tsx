"use client";

import { useMemo } from "react";
import Link from "next/link";
import { IconPause } from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { formatMoney, formatRelativeTime } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

export function CashierHeldBillsWidget({ data }: { data: DashboardData }) {
  const { holds, holdCount, pharmacistHolds } = data;
  const rxWaiting = pharmacistHolds.length;

  const oldestHoldWait = useMemo(() => {
    if (holds.length === 0) return null;
    const oldest = holds.reduce((a, b) => (new Date(a.createdAt) < new Date(b.createdAt) ? a : b));
    return formatRelativeTime(oldest.createdAt);
  }, [holds]);

  return (
    <DashboardPanel
      title="Held Bills"
      compact
      footerHref="/pos"
      footerLabel="Recall in POS →"
      footerMeta={oldestHoldWait ? `Oldest ${oldestHoldWait}` : `${holdCount} held`}
    >
      {holds.length === 0 ? (
        <p className={css.emptyState}>No held sales.</p>
      ) : (
        <>
          <div className={css.teamStatStrip} style={{ marginBottom: "0.65rem" }}>
            <div className={css.teamStatCell}>
              <div className={css.teamStatCopy}>
                <strong className={css.teamStatValue}>{holdCount}</strong>
                <span className={css.teamStatLabel}>Held</span>
              </div>
            </div>
            <div className={css.teamStatCell}>
              <div className={css.teamStatCopy}>
                <strong className={`${css.teamStatValue} ${css.teamStatValue_success}`}>
                  {holdCount - rxWaiting}
                </strong>
                <span className={css.teamStatLabel}>Ready</span>
              </div>
            </div>
            <div className={css.teamStatCell}>
              <div className={css.teamStatCopy}>
                <strong className={`${css.teamStatValue} ${css.teamStatValue_danger}`}>{rxWaiting}</strong>
                <span className={css.teamStatLabel}>Awaiting Rx</span>
              </div>
            </div>
          </div>
          <ul className={css.pipelineList}>
            {holds.slice(0, 5).map((h) => (
              <li key={h.id}>
                <Link href={`/pos?panel=holds&holdId=${h.id}`}>
                  <span
                    className={css.pipelineIcon}
                    aria-hidden
                    style={{
                      color: h.needsPharmacist ? "var(--pc-alert-error-icon)" : "var(--pc-alert-success-icon)",
                      background: h.needsPharmacist
                        ? "color-mix(in srgb, var(--pc-alert-error-icon) 14%, var(--pc-card-bg))"
                        : "color-mix(in srgb, var(--pc-alert-success-icon) 14%, var(--pc-card-bg))",
                    }}
                  >
                    <IconPause size={14} strokeWidth={1.75} />
                  </span>
                  <span className={css.pipelineRowBody}>
                    <strong>{h.holdRef}</strong>
                    <span className={css.muted}>
                      {h.label || h.heldByName} · {formatRelativeTime(h.createdAt)}
                    </span>
                  </span>
                  {h.needsPharmacist ? <StatusBadge status="pending" label="Rx" variant="danger" /> : null}
                  <span>{formatMoney(h.total)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </DashboardPanel>
  );
}
