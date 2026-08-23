"use client";

import type { ReactNode } from "react";
import { IconAlertTriangle, IconCheckCircle, IconTag, IconTrophy } from "@/components/icons";
import css from "../reports.module.css";

export type OpportunityTag = { id: string; label: string };
export type QuadrantKey = "highMarginHighRevenue" | "highMarginLowRevenue" | "lowMarginHighRevenue" | "lowMarginLowRevenue";

type Props = {
  quadrants: Record<QuadrantKey, OpportunityTag[]>;
  /** Fully-formed description of where the margin split sits, e.g. "42.0% target margin" or
   *  "24.3% portfolio average" (when no target is configured) — the caller owns which basis to
   *  quote, this component just displays it. */
  marginSplitLabel: string;
  /** Same idea for the revenue split, e.g. "LKR 45,231 median revenue". */
  revenueSplitLabel: string;
  onTagClick?: (id: string) => void;
  activeId?: string | null;
};

const QUADRANT_DEFS: Array<{ key: QuadrantKey; title: string; subtitle: string; tone: "primary" | "info" | "warning" | "danger"; icon: ReactNode }> = [
  { key: "highMarginLowRevenue", title: "Growth Opportunity", subtitle: "High margin, lower revenue", tone: "info", icon: <IconCheckCircle size={14} /> },
  { key: "highMarginHighRevenue", title: "Protect & Grow", subtitle: "High margin, high revenue", tone: "primary", icon: <IconTrophy size={14} /> },
  { key: "lowMarginLowRevenue", title: "Review", subtitle: "Low margin, lower revenue", tone: "warning", icon: <IconTag size={14} /> },
  { key: "lowMarginHighRevenue", title: "Fix Margin", subtitle: "Low margin, high revenue", tone: "danger", icon: <IconAlertTriangle size={14} /> },
];

/** 2×2 classification grid — which categories combine strong/weak margin with high/low revenue,
 *  sorted into four labeled boxes instead of a scatter plot. Faster to scan than a bubble chart
 *  when the goal is just "which quadrant is this category in", not its exact coordinates. */
export function CategoryOpportunityMatrix({ quadrants, marginSplitLabel, revenueSplitLabel, onTagClick, activeId }: Props) {
  const isEmpty = QUADRANT_DEFS.every((q) => quadrants[q.key].length === 0);
  if (isEmpty) {
    return <p className={css.emptyNote}>No categorized sales in this range yet.</p>;
  }

  return (
    <div>
      <div className={css.oppMatrixGrid}>
        {QUADRANT_DEFS.map((q) => (
          <div key={q.key} className={`${css.oppQuadrant} ${css[`oppQuadrant_${q.tone}`]}`}>
            <div className={css.oppQuadrantHead}>
              <span className={`${css.oppQuadrantIcon} ${css[`oppQuadrantIcon_${q.tone}`]}`}>{q.icon}</span>
              <div>
                <div className={css.oppQuadrantTitle}>{q.title}</div>
                <div className={css.oppQuadrantSubtitle}>{q.subtitle}</div>
              </div>
            </div>
            <div className={css.oppTagRow}>
              {quadrants[q.key].length === 0 ? (
                <span className={css.oppTagEmpty}>No categories in this quadrant</span>
              ) : (
                quadrants[q.key].map((tag) =>
                  onTagClick ? (
                    <button
                      key={tag.id}
                      type="button"
                      className={`${css.oppTag} ${css[`oppTag_${q.tone}`]} ${activeId === tag.id ? css.oppTagActive : ""}`}
                      onClick={() => onTagClick(tag.id)}
                    >
                      {tag.label}
                    </button>
                  ) : (
                    <span key={tag.id} className={`${css.oppTag} ${css[`oppTag_${q.tone}`]}`}>
                      {tag.label}
                    </span>
                  ),
                )
              )}
            </div>
          </div>
        ))}
      </div>
      <div className={css.oppMatrixFoot}>
        Quadrants split at {marginSplitLabel} and {revenueSplitLabel}.
      </div>
    </div>
  );
}
