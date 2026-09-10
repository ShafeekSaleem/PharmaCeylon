"use client";

import type { AgeBucketKey } from "../lib/types";
import css from "../reports.module.css";

export type AgeingProfileBucket = { key: AgeBucketKey; label: string; value: number; pct: number };

/** Freshest → oldest, teal through red — reused by the trend chart below so both panels read as
 *  one consistent color language for "how old is this stock". */
export const AGE_BUCKET_COLORS: Record<AgeBucketKey, string> = {
  "0-30": "var(--pc-primary)",
  "31-60": "var(--pc-tone-mint)",
  "61-90": "#eab308",
  "91-180": "var(--pc-tone-orange)",
  "180+": "var(--pc-tone-danger)",
};

type Props = {
  buckets: AgeingProfileBucket[];
  formatValue: (n: number) => string;
};

/** Compact 100%-stacked bar for a single table row — the age-bucket composition at a glance,
 *  exact value/percent per segment on hover. Lives inline in a DataTable cell (Sub-category
 *  Ageing Breakdown) rather than as its own full-size chart, so that table isn't duplicating the
 *  same per-bucket numbers a separate chart would show. */
export function AgeingMiniBar({ buckets, formatValue }: Props) {
  return (
    <div className={css.ageingMiniTrack}>
      {buckets.map((b) =>
        b.pct > 0 ? (
          <div
            key={b.key}
            className={css.ageingMiniSegment}
            style={{ width: `${b.pct}%`, background: AGE_BUCKET_COLORS[b.key] }}
            data-tooltip={`${b.label}: ${formatValue(b.value)} (${b.pct.toFixed(0)}%)`}
          />
        ) : null,
      )}
    </div>
  );
}
