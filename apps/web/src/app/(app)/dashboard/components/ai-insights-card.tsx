"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { IconActivity, IconAlertTriangle, IconInfo } from "@/components/icons";
import { ActionsPanel, type ActionPanelItem } from "@/app/(app)/reports/components/actions-panel";
import type { AiInsight } from "../lib/placeholder-data";

type Props = {
  title?: string;
  insights?: AiInsight[];
  footerHref?: string;
  footerLabel?: string;
  /** Items per page — pass a smaller number for insights that carry `examples` chips (taller
   * cards), so the widget's height stays fixed instead of growing as content gets richer. */
  pageSize?: number;
};

/** Dashboard tones map onto the reports "cards" palette — warning/danger keep their exact
 * semantics, "info" (low-urgency, general) reads better as the neutral `muted` tone, and
 * "success" as the brand-colored `primary` tone (there's no dedicated green in this palette). */
const TONE_MAP: Record<NonNullable<AiInsight["tone"]>, ActionPanelItem["tone"]> = {
  warning: "warning",
  danger: "danger",
  info: "muted",
  success: "primary",
};

function toneIcon(tone: ActionPanelItem["tone"]): ReactNode {
  switch (tone) {
    case "warning":
    case "danger":
      return <IconAlertTriangle size={14} strokeWidth={1.75} />;
    case "primary":
      return <IconActivity size={14} strokeWidth={1.75} />;
    default:
      return <IconInfo size={14} strokeWidth={1.75} />;
  }
}

/** Shared `AiInsight` → `ActionPanelItem` mapping — used here for the dashboard widget preview,
 * and by the `/insights` hub page so both render insights identically and never drift apart. */
export function insightToActionPanelItem(insight: AiInsight, onNavigate: (href: string) => void): ActionPanelItem {
  const tone = TONE_MAP[insight.tone ?? "info"];
  return {
    key: insight.id,
    icon: toneIcon(tone),
    tone,
    title: insight.title,
    description: insight.detail,
    count: insight.count,
    countLabel: insight.countLabel,
    countText: insight.countText,
    examples: insight.examples,
    onClick: insight.href ? () => onNavigate(insight.href!) : undefined,
  };
}

/** Renders dashboard AI insights through the same `ActionsPanel` "cards" component reports pages
 * use for every "X Insights" panel, so the row design (icon square, title/description, chevron
 * badge) is identical everywhere instead of dashboard and reports maintaining look-alike copies. */
export function AiInsightsCard({
  title = "AI Insights & Recommendations",
  insights = [],
  footerHref,
  footerLabel,
  pageSize,
}: Props) {
  const router = useRouter();

  const items: ActionPanelItem[] = insights.map((insight) => insightToActionPanelItem(insight, router.push));

  return (
    <ActionsPanel
      title={title}
      items={items}
      variant="cards"
      pageSize={pageSize}
      onViewAll={footerHref ? () => router.push(footerHref) : undefined}
      viewAllLabel={footerLabel ?? "View all insights"}
    />
  );
}
