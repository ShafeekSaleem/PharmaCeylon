"use client";

import type { ReactNode } from "react";
import { IconEye, IconSearch, IconTag, IconTarget } from "@/components/icons";
import css from "../reports.module.css";

export type SeverityQuadrantKey = "recoverFast" | "investigate" | "monitor" | "liquidate";

export type SeverityQuadrantData = { skuCount: number; value: number };

type Props = {
  quadrants: Record<SeverityQuadrantKey, SeverityQuadrantData>;
  formatValue: (n: number) => string;
  onQuadrantClick?: (key: SeverityQuadrantKey) => void;
  activeQuadrant?: SeverityQuadrantKey | null;
};

const QUADRANT_META: Record<SeverityQuadrantKey, { title: string; description: string; icon: ReactNode; tone: string }> = {
  recoverFast: { title: "Recover Fast", description: "High value, recent inactivity", icon: <IconTarget size={16} />, tone: "recoverFast" },
  investigate: { title: "Investigate", description: "High value, long inactivity", icon: <IconSearch size={16} />, tone: "investigate" },
  monitor: { title: "Monitor", description: "Low value, recent inactivity", icon: <IconEye size={16} />, tone: "monitor" },
  liquidate: { title: "Liquidate", description: "Low value, long inactivity", icon: <IconTag size={16} />, tone: "liquidate" },
};

const ORDER: SeverityQuadrantKey[] = ["recoverFast", "investigate", "monitor", "liquidate"];

/** 2×2 severity matrix — Stock Value by Commercial Category (i.e. where) since Dead Stock's own
 *  distinctive visual, mirroring the reference: Y = stock value (low/high, split at the dead-stock
 *  population's own median), X = days since last sale (low/high, split at 2× the selected
 *  inactivity threshold). Both axis splits are computed server-side (see `ReportsService.deadStock`)
 *  so the four counts always reconcile with Dead Stock SKUs/Value. */
export function DeadStockSeverityMatrix({ quadrants, formatValue, onQuadrantClick, activeQuadrant }: Props) {
  return (
    <div className={css.matrixOuter}>
      <div className={css.matrixYAxis}>
        <span>High</span>
        <span className={css.matrixAxisLabel}>STOCK VALUE</span>
        <span>Low</span>
      </div>
      <div className={css.matrixBody}>
        <div className={css.matrixGrid}>
          {ORDER.map((key) => {
            const meta = QUADRANT_META[key];
            const data = quadrants[key];
            const Tag = onQuadrantClick ? "button" : "div";
            return (
              <Tag
                key={key}
                type={onQuadrantClick ? "button" : undefined}
                className={`${css.matrixQuad} ${css[meta.tone]}${activeQuadrant === key ? ` ${css.matrixQuadActive}` : ""}`}
                aria-pressed={onQuadrantClick ? activeQuadrant === key : undefined}
                onClick={onQuadrantClick ? () => onQuadrantClick(key) : undefined}
              >
                <span className={`${css.matrixQuadIcon} ${css[meta.tone]}`}>{meta.icon}</span>
                <span className={css.matrixQuadTitle}>{meta.title.toUpperCase()}</span>
                <span className={css.matrixQuadDesc}>{meta.description}</span>
                <span className={css.matrixQuadStats}>
                  <span className={css.matrixQuadCount}>{data.skuCount} SKUs</span>
                  <span className={css.matrixQuadValue}>{formatValue(data.value)}</span>
                </span>
              </Tag>
            );
          })}
        </div>
        <div className={css.matrixXAxis}>
          <span>Low</span>
          <span className={css.matrixAxisLabel}>DAYS SINCE LAST SALE</span>
          <span>High</span>
        </div>
      </div>
    </div>
  );
}
