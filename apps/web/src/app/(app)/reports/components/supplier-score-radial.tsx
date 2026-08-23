"use client";

import css from "../reports.module.css";

export type SupplierScorePoint = {
  supplierId: string;
  supplierName: string;
  score: number;
  grade: "preferred" | "good" | "monitor" | "review";
};

type Props = {
  points: SupplierScorePoint[];
  onSupplierClick?: (supplierId: string) => void;
  activeSupplierId?: string | null;
};

const GRADE_COLOR: Record<SupplierScorePoint["grade"], string> = {
  preferred: "#16a34a",
  good: "#0284c7",
  monitor: "#ea580c",
  review: "#dc2626",
};
const GRADE_LABEL: Record<SupplierScorePoint["grade"], string> = {
  preferred: "Preferred",
  good: "Good",
  monitor: "Monitor",
  review: "Review",
};

const R = 26;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** A ring gauge per supplier (score 0-100 as sweep angle, colored by grade) laid out in a
 *  responsive grid — deliberately not another horizontal bar list (the Supplier Performance
 *  Matrix and Purchase Summary/Supplier Spend's own ranking panels already own that visual
 *  family), so this page reads as its own thing at a glance instead of a third copy of the same
 *  chart shape. */
export function SupplierScoreRadialGrid({ points, onSupplierClick, activeSupplierId }: Props) {
  if (points.length === 0) {
    return <p className={css.emptyNote}>No supplier scores in this range yet.</p>;
  }

  return (
    <div className={css.scoreRadialGrid}>
      {points.map((p) => {
        const pct = Math.max(0, Math.min(100, p.score));
        const offset = CIRCUMFERENCE * (1 - pct / 100);
        const color = GRADE_COLOR[p.grade];
        return (
          <button
            key={p.supplierId}
            type="button"
            className={`${css.scoreRadialCard}${onSupplierClick ? ` ${css.scoreRadialClickable}` : ""}${activeSupplierId === p.supplierId ? ` ${css.scoreRadialActive}` : ""}`}
            onClick={onSupplierClick ? () => onSupplierClick(p.supplierId) : undefined}
            disabled={!onSupplierClick}
            data-tooltip={`${p.supplierName} — ${p.score.toFixed(0)} / 100 (${GRADE_LABEL[p.grade]})`}
          >
            <svg viewBox="0 0 64 64" width={64} height={64} className={css.scoreRadialSvg}>
              <circle cx={32} cy={32} r={R} fill="none" stroke="var(--pc-muted-bg)" strokeWidth={6} />
              <circle
                cx={32}
                cy={32}
                r={R}
                fill="none"
                stroke={color}
                strokeWidth={6}
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={offset}
                transform="rotate(-90 32 32)"
              />
              <text x={32} y={35} textAnchor="middle" className={css.scoreRadialValue}>
                {Math.round(p.score)}
              </text>
            </svg>
            <span className={css.scoreRadialName}>{p.supplierName}</span>
            <span className={css.scoreRadialGrade} style={{ color }}>{GRADE_LABEL[p.grade]}</span>
          </button>
        );
      })}
    </div>
  );
}
