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
  insights?: AiInsight[];
  footerHref?: string;
  footerLabel?: string;
  footerMeta?: string;
  compact?: boolean;
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
  insights = [],
  footerHref,
  footerLabel = "View all insights →",
  footerMeta,
  compact,
}: Props) {
  return (
    <DashboardPanel
      title={title}
      icon={<IconSparkles size={14} />}
      compact={compact}
      footerHref={footerHref}
      footerLabel={footerHref ? footerLabel : undefined}
      footerMeta={footerMeta}
    >
      {insights.length > 0 ? (
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
                  <Link href={item.href} className={`${css.aiItem} ${css[`aiTone_${tone}`]}`}>
                    {row}
                  </Link>
                ) : (
                  <div className={`${css.aiItem} ${css[`aiTone_${tone}`]}`}>{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={css.emptyState}>No insights right now.</p>
      )}
    </DashboardPanel>
  );
}
