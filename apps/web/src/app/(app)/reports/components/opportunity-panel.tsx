"use client";

import { IconSparkles } from "@/components/icons";
import { formatMoney } from "../lib/format";
import css from "../reports.module.css";

export type OpportunityRow = { key: string; name: string; marginPct: number; unitsSold: number; opportunity: number };

type Props = {
  totalOpportunity: number;
  targetPct: number;
  rows: OpportunityRow[];
  onViewAll?: () => void;
};

export function OpportunityPanel({ totalOpportunity, targetPct, rows, onViewAll }: Props) {
  return (
    <div className={css.card}>
      <div className={css.cardhead}>
        <div>
          <h3>Margin Opportunities</h3>
          <p>High-revenue, low-margin products with improvement potential.</p>
        </div>
      </div>

      <div className={css.opportunityCallout}>
        <div className={css.opportunityCalloutHead}>
          <IconSparkles size={14} />
          Estimated period profit opportunity
        </div>
        <div className={css.opportunityCalloutValue}>{formatMoney(totalOpportunity)}</div>
        <div className={css.opportunityCalloutSub}>Potential increase if margin improved to {targetPct.toFixed(1)}%</div>
      </div>

      {rows.length === 0 ? (
        <p className={css.emptyNote}>No clear opportunities in this range.</p>
      ) : (
        <div>
          {rows.map((r) => (
            <div className={css.opportunityRow} key={r.key}>
              <span className={css.opportunityName}>{r.name}</span>
              <span className={css.opportunityMetaDanger}>{r.marginPct.toFixed(1)}%</span>
              <span className={css.opportunityMeta}>{r.unitsSold.toLocaleString("en-IN")} units</span>
              <span className={css.opportunityValue}>{formatMoney(r.opportunity)}</span>
            </div>
          ))}
        </div>
      )}

      {onViewAll ? (
        <button type="button" className={css.reviewBtn} onClick={onViewAll}>
          View all opportunities
        </button>
      ) : null}
    </div>
  );
}
