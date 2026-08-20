"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { IconChevronDown, IconChevronRight, IconChevronUp } from "@/components/icons";
import type { ChartPoint } from "./simple-charts";
import css from "../dashboard.module.css";

export type HeroTrend = {
  label: string;
  direction: "up" | "down";
  /** Defaults to matching direction (up → positive, down → danger). */
  tone?: "positive" | "danger";
};

export type HeroSecondaryMetric = {
  key: string;
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  trend?: HeroTrend;
  /** When set, shows a small "go to detail" link in the tile's bottom-right corner. */
  href?: string;
  /** Text revealed next to the arrow on hover/focus, e.g. "Open POs". Defaults to "View". */
  linkLabel?: string;
};

type Props = {
  label: string;
  value: ReactNode;
  /** Right-aligned eyebrow text, e.g. "All branches · vs yesterday". */
  scope?: string;
  meta?: ReactNode;
  trend?: HeroTrend;
  /** Optional inline trend line drawn behind the primary metric. */
  sparkline?: ChartPoint[];
  secondary: HeroSecondaryMetric[];
  loading?: boolean;
};

export function TrendChip({ trend }: { trend: HeroTrend }) {
  const tone = trend.tone ?? (trend.direction === "up" ? "positive" : "danger");
  const cls =
    tone === "danger" ? css.trendChipDown : css.trendChipUp;
  return (
    <span className={`${css.trendChip} ${cls}`}>
      {trend.direction === "up" ? (
        <IconChevronUp size={10} strokeWidth={3} aria-hidden />
      ) : (
        <IconChevronDown size={10} strokeWidth={3} aria-hidden />
      )}
      {trend.label}
    </span>
  );
}

function HeroSpark({ points }: { points: ChartPoint[] }) {
  const w = 150;
  const h = 46;
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1) * 1.15;
  const min = Math.min(0, ...values);
  const range = Math.max(max - min, 1);
  const coords = points.map((p, i) => ({
    x: points.length === 1 ? w / 2 : (i / (points.length - 1)) * w,
    y: h - ((p.value - min) / range) * h,
  }));
  const line = coords.map((c) => `${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" L ");
  const path = `M ${line}`;
  const area = `${path} L ${coords[coords.length - 1]!.x.toFixed(1)} ${h} L 0 ${h} Z`;
  const last = coords[coords.length - 1]!;

  return (
    <svg
      className={css.heroSpark}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id="heroSparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--pc-primary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--pc-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#heroSparkGrad)" />
      <path
        d={path}
        fill="none"
        stroke="var(--pc-primary)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last.x} cy={last.y} r="3" fill="var(--pc-primary)" />
    </svg>
  );
}

export function HeroBand({
  label,
  value,
  scope,
  meta,
  trend,
  sparkline,
  secondary,
  loading,
}: Props) {
  const columns = `1.5fr ${secondary.map(() => "1fr").join(" ")}`.trim();

  return (
    <section
      className={css.hero}
      style={{ gridTemplateColumns: columns }}
      aria-label="Key figures"
    >
      <div className={`${css.heroCell} ${css.heroCellPrimary}`}>
        <div className={css.heroEyebrow}>
          <span>{label}</span>
          {scope ? <span className={css.heroScope}>{scope}</span> : null}
        </div>
        <div className={css.heroValueRow}>
          <span className={css.heroValue}>{loading ? "…" : value}</span>
          {!loading && trend ? <TrendChip trend={trend} /> : null}
        </div>
        {meta ? <p className={css.heroMeta}>{meta}</p> : null}
        {!loading && sparkline && sparkline.length > 1 ? (
          <HeroSpark points={sparkline} />
        ) : null}
      </div>
      {secondary.map((m) => {
        const hasLink = !loading && m.href;
        const cellCls = [css.heroCell, hasLink ? css.heroCellWithLink : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={m.key} className={cellCls}>
            <div className={css.heroEyebrow}>
              <span>{m.label}</span>
            </div>
            <div className={css.heroValueRow}>
              <span className={css.heroValue}>{loading ? "…" : m.value}</span>
            </div>
            {!loading && (m.meta || m.trend) ? (
              <p className={css.heroMeta}>
                {m.meta}
                {m.trend ? (
                  <span style={{ marginLeft: m.meta ? "0.4rem" : 0 }}>
                    <TrendChip trend={m.trend} />
                  </span>
                ) : null}
              </p>
            ) : null}
            {hasLink ? (
              <Link href={m.href!} className={css.heroCellLink} aria-label={m.linkLabel ?? `View ${m.label}`}>
                <span className={css.heroCellLinkText}>{m.linkLabel ?? "View"}</span>
                <IconChevronRight size={13} strokeWidth={2.25} />
              </Link>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
