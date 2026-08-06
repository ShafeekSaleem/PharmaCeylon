"use client";

import css from "../dashboard.module.css";

type Props = {
  value: number;
  max?: number;
  label?: string;
  /** Optional semantic fill (e.g. under-target warning). */
  tone?: "primary" | "success" | "warning" | "danger";
};

const TONE_CLASS: Record<NonNullable<Props["tone"]>, string> = {
  primary: css.progressFill_primary,
  success: css.progressFill_success,
  warning: css.progressFill_warning,
  danger: css.progressFill_danger,
};

export function ProgressBar({ value, max = 100, label, tone = "primary" }: Props) {
  const pct = Math.max(0, Math.min(100, max === 0 ? 0 : (value / max) * 100));
  return (
    <div className={css.progressWrap}>
      <div className={css.progressTrack}>
        <div
          className={`${css.progressFill} ${TONE_CLASS[tone]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {label != null ? <span className={css.progressLabel}>{label}</span> : null}
    </div>
  );
}
