"use client";

import { IconCalendar } from "@/components/icons";
import { formatMoney } from "../lib/format";
import type { ExpiryTier } from "../lib/types";
import css from "../reports.module.css";

const TIER_META: Record<
  ExpiryTier,
  { label: string; range: string; color: string; actionLabel: string }
> = {
  critical: { label: "Critical", range: "≤ 30 days", color: "#dc2626", actionLabel: "Take action now" },
  watch: { label: "Watch", range: "31–60 days", color: "#ea580c", actionLabel: "Act within 2–4 weeks" },
  notice: { label: "Upcoming", range: "61–90 days", color: "#ca8a04", actionLabel: "Plan ahead" },
};

export type SeveritySummary = Record<ExpiryTier, { count: number; value: number }>;

export function SeverityCards({ summary, onViewCritical }: { summary: SeveritySummary; onViewCritical?: () => void }) {
  return (
    <div className={css.severityGrid}>
      {(["critical", "watch", "notice"] as ExpiryTier[]).map((tier) => {
        const meta = TIER_META[tier];
        const s = summary[tier];
        return (
          <div key={tier} className={`${css.severityCard} ${css[tier]}`}>
            <div className={css.severityTop}>
              <span className={css.severityLabel}>
                <span className={css.severityIcon} style={{ background: `color-mix(in srgb, ${meta.color} 16%, #fff)`, color: meta.color }}>
                  <IconCalendar size={14} />
                </span>
                {meta.label}
              </span>
              <span className={`${css.actionPill} ${css[tier]}`}>{meta.actionLabel}</span>
            </div>
            <span className={css.severityRange}>{meta.range}</span>
            <span className={css.severityCount}>{s.count} batches</span>
            <span className={css.severityValue}>{formatMoney(s.value)} value at risk</span>
            {tier === "critical" && s.count > 0 && onViewCritical ? (
              <button type="button" className={css.severityCta} onClick={onViewCritical}>
                View batches
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
