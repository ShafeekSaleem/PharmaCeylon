"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconAlertTriangle,
  IconChevronRight,
  IconInfo,
  IconSparkles,
} from "@/components/icons";
import type { AiInsight } from "../lib/placeholder-data";
import { DashboardPanel } from "./dashboard-panel";
import css from "../dashboard.module.css";

type Props = {
  title?: string;
  insights: AiInsight[];
  footerHref?: string;
  footerLabel?: string;
  footerMeta?: string;
  /** Card grid (manager mockup) vs compact list. */
  layout?: "list" | "cards";
  compact?: boolean;
  /** When false, omit the Sample badge / disclaimer (live data-driven insights). */
  showSampleBadge?: boolean;
};

function toneIcon(tone: AiInsight["tone"]): ReactNode {
  switch (tone) {
    case "warning":
      return <IconAlertTriangle size={13} strokeWidth={1.75} />;
    case "danger":
      return <IconAlertTriangle size={13} strokeWidth={1.75} />;
    case "success":
      return <IconActivity size={13} strokeWidth={1.75} />;
    default:
      return <IconInfo size={13} strokeWidth={1.75} />;
  }
}

export function AiInsightsCard({
  title = "AI Insights & Recommendations",
  insights,
  footerHref,
  footerLabel = "View all insights →",
  footerMeta,
  layout = "list",
  compact,
  showSampleBadge = true,
}: Props) {
  return (
    <DashboardPanel
      title={title}
      icon={<IconSparkles size={14} />}
      compact={compact}
      badge={
        showSampleBadge ? (
          <span className={css.placeholderBadge} title="Placeholder recommendations">
            Sample
          </span>
        ) : undefined
      }
      footerHref={footerHref}
      footerLabel={footerHref ? footerLabel : undefined}
      footerMeta={footerMeta}
    >
      {showSampleBadge ? (
        <p className={css.placeholderNote}>
          Sample recommendations for layout preview — not live AI output.
        </p>
      ) : null}
      {layout === "cards" ? (
        <div className={css.aiCards}>
          {insights.map((item) => (
            <div
              key={item.id}
              className={`${css.aiCard} ${css[`aiTone_${item.tone ?? "info"}`]}`}
            >
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
              {item.href ? (
                <Link href={item.href} className={css.aiCardAction}>
                  {item.actionLabel ?? "Review"}
                </Link>
              ) : (
                <span className={css.muted}>Coming soon</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <ul className={css.aiList}>
          {insights.map((item) => {
            const tone = item.tone ?? "info";
            const row = (
              <>
                <span className={`${css.aiIcon} ${css[`aiIcon_${tone}`]}`} aria-hidden>
                  {toneIcon(tone)}
                </span>
                <div className={css.aiItemBody}>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                </div>
                <span className={css.aiChevron} aria-hidden>
                  <IconChevronRight size={14} strokeWidth={1.75} />
                </span>
              </>
            );
            return (
              <li key={item.id}>
                {item.href ? (
                  <Link
                    href={item.href}
                    className={`${css.aiItem} ${css[`aiTone_${tone}`]}`}
                  >
                    {row}
                  </Link>
                ) : (
                  <div className={`${css.aiItem} ${css[`aiTone_${tone}`]}`}>{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DashboardPanel>
  );
}
